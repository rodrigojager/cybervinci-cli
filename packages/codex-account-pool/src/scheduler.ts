import { hostname } from "node:os"
import { randomUUID } from "node:crypto"
import { jobsFileSchema, type ResumeJob, type Settings } from "./domain"
import { paths, readJson, transact } from "./storage"
import { AccountStore } from "./store"
import { BindingStore, earliestAccount } from "./bindings"
import { QuotaService, blockedUntil } from "./quota"
import { LedgerStore } from "./ledger"

const empty = () => ({ version: 1 as const, revision: 0, jobs: [] as ResumeJob[] })

const inFlightStates = new Set<ResumeJob["state"]>(["claimed", "resuming"])

function cancelWaiting(job: ResumeJob, now: number) {
  job.state = "cancelled"
  job.owner = undefined
  job.updatedAt = now
}

function normalizeSessionJobs(jobs: ResumeJob[], sessionID: string, now: number) {
  const sessionJobs = jobs.filter((item) => item.sessionID === sessionID)
  const inFlight = sessionJobs.filter((item) => inFlightStates.has(item.state)).sort((a, b) => b.epoch - a.epoch || b.updatedAt - a.updatedAt)
  if (inFlight.length) {
    for (const item of sessionJobs) if (item.state === "waiting") cancelWaiting(item, now)
    return inFlight[0]
  }

  const waiting = sessionJobs.filter((item) => item.state === "waiting").sort((a, b) => b.epoch - a.epoch || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id))
  const keeper = waiting[0]
  for (const item of waiting.slice(1)) cancelWaiting(item, now)
  return keeper
}

export class JobStore {
  constructor(readonly path = paths.jobs) {}
  async snapshot() { return readJson(this.path, jobsFileSchema, empty) }
  private update<R>(fn: (data: ReturnType<typeof empty>) => R | Promise<R>) {
    return transact({ key: `scheduler:${this.path}`, path: this.path, schema: jobsFileSchema, fallback: empty, async update(data) { const result = await fn(data); data.revision++; return result } })
  }
  async put(job: ResumeJob) {
    return this.update((data) => {
      const now = Date.now()
      const existing = normalizeSessionJobs(data.jobs, job.sessionID, now)
      if (existing && inFlightStates.has(existing.state)) return structuredClone(existing)
      if (existing?.state === "waiting") {
        if (job.epoch >= existing.epoch) {
          const id = existing.id
          const createdAt = existing.createdAt
          Object.assign(existing, job, { id, state: "waiting", owner: undefined, attempts: 0, createdAt, updatedAt: now })
          existing.lastError = undefined
        }
        return structuredClone(existing)
      }
      const index = data.jobs.findIndex((item) => item.id === job.id)
      if (index >= 0) data.jobs[index] = job
      else data.jobs.push(job)
      return structuredClone(job)
    })
  }
  async cancelSession(sessionID: string) { return this.update((data) => { for (const job of data.jobs) if (job.sessionID === sessionID && !["completed", "cancelled"].includes(job.state)) { job.state = "cancelled"; job.updatedAt = Date.now() } }) }
  async claim(instanceID: string, leaseMs: number, blockedAccounts = new Set<string>()) {
    return this.update((data) => {
      const now = Date.now()
      for (const item of data.jobs) if (item.owner && item.owner.leaseUntil <= now && ["claimed", "resuming"].includes(item.state)) { item.owner = undefined; item.state = "waiting" }
      for (const sessionID of new Set(data.jobs.filter((item) => ["waiting", "claimed", "resuming"].includes(item.state)).map((item) => item.sessionID))) normalizeSessionJobs(data.jobs, sessionID, now)
      const job = data.jobs.filter((item) => item.state === "waiting" && item.resumeAt <= now && !blockedAccounts.has(item.targetAccountID)).sort((a, b) => a.resumeAt - b.resumeAt || a.createdAt - b.createdAt)[0]
      if (!job) return
      job.state = "claimed"; job.owner = { instanceID, pid: process.pid, hostname: hostname(), leaseUntil: now + leaseMs }; job.updatedAt = now
      return structuredClone(job)
    })
  }
  async renew(id: string, instanceID: string, leaseMs: number) { return this.update((data) => { const job = data.jobs.find((item) => item.id === id && item.owner?.instanceID === instanceID); if (!job?.owner) return false; job.owner.leaseUntil = Date.now() + leaseMs; job.updatedAt = Date.now(); return true }) }
  async finish(id: string, state: ResumeJob["state"], update: Partial<ResumeJob> = {}) { return this.update((data) => { const job = data.jobs.find((item) => item.id === id); if (!job) return; Object.assign(job, update, { state, updatedAt: Date.now() }); if (["waiting", "completed", "failed", "cancelled"].includes(state)) job.owner = undefined; return job }) }
}

export interface WaitInput {
  sessionID: string
  goalID?: string
  agent: string
  model: { providerID: string; modelID: string; variant?: string }
  targetAccountID: string
  resumeAt: number
  epoch: number
}

export class ResumeScheduler {
  readonly instanceID = `${hostname()}:${process.pid}:${randomUUID()}`
  private timer?: ReturnType<typeof setInterval>
  private ticking = false
  private active = new Map<string, string>()
  constructor(
    private client: any,
    private directory: string,
    private settings: () => Promise<Settings>,
    private jobs = new JobStore(),
    private accounts = new AccountStore(),
    private bindings = new BindingStore(),
    private quota = new QuotaService(accounts),
    private ledger = new LedgerStore(),
  ) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), 1000)
    this.timer.unref?.()
    void this.tick()
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined }

  async wait(input: WaitInput) {
    const now = Date.now()
    return this.jobs.put({ id: `resume:${input.sessionID}:${input.epoch}`, sessionID: input.sessionID, goalID: input.goalID, goalActive: true, state: "waiting", resumeAt: input.resumeAt, targetAccountID: input.targetAccountID, epoch: input.epoch, agent: input.agent, model: input.model, attempts: 0, createdAt: now, updatedAt: now })
  }

  async cancel(sessionID: string) { return this.jobs.cancelSession(sessionID) }

  private async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      const settings = await this.settings()
      if (!settings.scheduler.autoResumeGoals) return
      const snapshot = await this.accounts.snapshot()
      const globalCapacity = Math.max(1, snapshot.accounts.filter((item) => item.enabled).length * settings.scheduler.maxConcurrentResumesPerAccount)
      while (this.active.size < globalCapacity) {
        const counts = new Map<string, number>()
        for (const accountID of this.active.values()) counts.set(accountID, (counts.get(accountID) ?? 0) + 1)
        const blocked = new Set([...counts].filter(([, count]) => count >= settings.scheduler.maxConcurrentResumesPerAccount).map(([id]) => id))
        const job = await this.jobs.claim(this.instanceID, settings.scheduler.leaseMs, blocked)
        if (!job) break
        this.active.set(job.id, job.targetAccountID)
        void this.resume(job, settings).finally(() => this.active.delete(job.id))
      }
    } finally { this.ticking = false }
  }

  private async resume(job: ResumeJob, settings: Settings) {
    const heartbeat = setInterval(() => void this.jobs.renew(job.id, this.instanceID, settings.scheduler.leaseMs), Math.max(5000, Math.floor(settings.scheduler.leaseMs / 3)))
    heartbeat.unref?.()
    try {
      const ledger = await this.ledger.get(job.sessionID)
      if (!ledger.goal || ledger.goal.status !== "active") {
        await this.jobs.finish(job.id, "cancelled", { lastError: "Goal is no longer active" })
        return
      }
      await this.client.session.get({ path: { id: job.sessionID }, query: { directory: this.directory } })
      const snapshot = await this.accounts.snapshot()
      let target = snapshot.accounts.find((item) => item.id === job.targetAccountID && item.enabled)
      if (!target) target = earliestAccount(snapshot.accounts)?.account
      if (!target) { await this.jobs.finish(job.id, "failed", { lastError: "No enabled account" }); return }
      if (target.id !== job.targetAccountID) { await this.jobs.finish(job.id, "waiting", { targetAccountID: target.id, resumeAt: Math.max(Date.now(), blockedUntil(target)), attempts: job.attempts + 1 }); return }
      await this.quota.refresh(target, true).catch(() => undefined)
      const refreshed = (await this.accounts.snapshot()).accounts.find((item) => item.id === target!.id) ?? target
      const available = blockedUntil(refreshed)
      if (available > Date.now()) {
        const earliest = earliestAccount((await this.accounts.snapshot()).accounts)
        await this.jobs.finish(job.id, "waiting", { resumeAt: earliest?.at ?? available, targetAccountID: earliest?.account.id ?? refreshed.id, attempts: job.attempts + 1 })
        return
      }
      await this.bindings.bind(job.sessionID, refreshed.id, { epoch: job.epoch, agent: job.agent, model: job.model })
      await this.jobs.finish(job.id, "resuming", { attempts: job.attempts + 1 })
      const history = await this.client.session.messages({ path: { id: job.sessionID }, query: { directory: this.directory } }).catch(() => ({ data: [] }))
      const marker = `<codex-account-pool-resume job="${job.id}" epoch="${job.epoch}"/>`
      const alreadySent = (history.data ?? []).some((message: any) => (message.parts ?? []).some((part: any) => part.type === "text" && String(part.text).includes(marker)))
      if (alreadySent) { await this.jobs.finish(job.id, "completed"); return }
      const delay = Math.floor(Math.random() * Math.max(1, settings.scheduler.resumeJitterMs))
      await new Promise((resolve) => setTimeout(resolve, delay))
      await this.client.session.prompt({
        path: { id: job.sessionID }, query: { directory: this.directory }, body: {
          agent: job.agent, model: { providerID: job.model.providerID, modelID: job.model.modelID }, variant: job.model.variant,
          parts: [{ type: "text", text: marker }],
        },
      })
      await this.jobs.finish(job.id, "completed")
      await new Promise((resolve) => setTimeout(resolve, settings.scheduler.resumeSpacingMs))
    } catch (error) {
      await this.jobs.finish(job.id, "waiting", { resumeAt: Date.now() + 60_000, attempts: job.attempts + 1, lastError: String(error).slice(0, 500) })
    } finally { clearInterval(heartbeat) }
  }
}
