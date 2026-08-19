import { hostname } from "node:os"
import {
  summaryQueueFileSchema,
  type ModelProfile,
  type SummaryCircuit,
  type SummaryJob,
  type SummaryPriority,
} from "./domain"
import { paths, readJson, transact } from "./storage"

const priorities: Record<SummaryPriority, number> = {
  routine: 0,
  quota: 1,
  emergency: 2,
}

const empty = (): {
  version: 1
  revision: number
  jobs: SummaryJob[]
  circuits: Record<string, SummaryCircuit>
} => ({ version: 1, revision: 0, jobs: [], circuits: {} })

export function modelKey(profile: ModelProfile) {
  return `${profile.providerID}/${profile.modelID}`
}

export class SummaryQueueStore {
  constructor(readonly path = paths.summaryQueue) {}

  snapshot() {
    return readJson(this.path, summaryQueueFileSchema, empty)
  }

  private update<R>(fn: (data: ReturnType<typeof empty>) => R | Promise<R>) {
    return transact({
      key: `summary-queue:${this.path}`,
      path: this.path,
      schema: summaryQueueFileSchema,
      fallback: empty,
      async update(data) {
        const result = await fn(data)
        data.revision++
        return result
      },
    })
  }

  put(sessionID: string, priority: SummaryPriority, force: boolean) {
    return this.update((data) => {
      const now = Date.now()
      const existing = data.jobs.find((item) => item.sessionID === sessionID)
      if (existing) {
        existing.priority = priorities[priority] > priorities[existing.priority] ? priority : existing.priority
        existing.force ||= force
        existing.dirty ||= existing.state === "claimed"
        if (existing.state === "waiting" && !existing.lastError)
          existing.nextAttemptAt = Math.min(existing.nextAttemptAt, now)
        existing.updatedAt = now
        return structuredClone(existing)
      }
      const job: SummaryJob = {
        id: `summary:${sessionID}`,
        sessionID,
        state: "waiting",
        priority,
        force,
        dirty: false,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      }
      data.jobs.push(job)
      return structuredClone(job)
    })
  }

  async claim(instanceID: string, leaseMs: number) {
    const current = await this.snapshot()
    const checkedAt = Date.now()
    const expired = current.jobs.some(
      (item) => item.state === "claimed" && (!item.owner || item.owner.leaseUntil <= checkedAt),
    )
    const active = current.jobs.some(
      (item) => item.state === "claimed" && item.owner && item.owner.leaseUntil > checkedAt,
    )
    const due = current.jobs.some((item) => item.state === "waiting" && item.nextAttemptAt <= checkedAt)
    if (!expired && (active || !due)) return

    return this.update((data) => {
      const now = Date.now()
      for (const item of data.jobs) {
        if (item.state !== "claimed" || !item.owner || item.owner.leaseUntil > now) continue
        item.state = "waiting"
        item.owner = undefined
        item.nextAttemptAt = Math.min(item.nextAttemptAt, now)
      }
      if (data.jobs.some((item) => item.state === "claimed" && item.owner && item.owner.leaseUntil > now)) return
      const job = data.jobs
        .filter((item) => item.state === "waiting" && item.nextAttemptAt <= now)
        .sort((a, b) => priorities[b.priority] - priorities[a.priority] || a.createdAt - b.createdAt)[0]
      if (!job) return
      job.state = "claimed"
      job.dirty = false
      job.owner = { instanceID, pid: process.pid, hostname: hostname(), leaseUntil: now + leaseMs }
      job.updatedAt = now
      return structuredClone(job)
    })
  }

  renew(id: string, instanceID: string, leaseMs: number) {
    return this.update((data) => {
      const job = data.jobs.find((item) => item.id === id && item.owner?.instanceID === instanceID)
      if (!job?.owner) return false
      job.owner.leaseUntil = Date.now() + leaseMs
      job.updatedAt = Date.now()
      return true
    })
  }

  complete(id: string, instanceID: string) {
    return this.update((data) => {
      const index = data.jobs.findIndex((item) => item.id === id && item.owner?.instanceID === instanceID)
      if (index < 0) return { requeued: false }
      const job = data.jobs[index]
      if (job.dirty) {
        job.state = "waiting"
        job.dirty = false
        job.owner = undefined
        job.nextAttemptAt = Date.now()
        job.updatedAt = Date.now()
        job.lastError = undefined
        return { requeued: true }
      }
      data.jobs.splice(index, 1)
      return { requeued: false }
    })
  }

  defer(id: string, instanceID: string, nextAttemptAt: number, error: string) {
    return this.update((data) => {
      const job = data.jobs.find((item) => item.id === id && item.owner?.instanceID === instanceID)
      if (!job) return false
      job.state = "waiting"
      job.force = true
      job.dirty = false
      job.owner = undefined
      job.nextAttemptAt = nextAttemptAt
      job.updatedAt = Date.now()
      job.lastError = error.slice(0, 500)
      return true
    })
  }

  cancel(sessionID: string) {
    return this.update((data) => {
      data.jobs = data.jobs.filter((item) => item.sessionID !== sessionID)
    })
  }

  block(profile: ModelProfile, category: string, error: string, cooldownMs: number) {
    return this.update((data) => {
      const key = modelKey(profile)
      const now = Date.now()
      const current = data.circuits[key]
      data.circuits[key] = {
        key,
        blockedUntil: Math.max(current?.blockedUntil ?? 0, now + cooldownMs),
        category,
        failures: (current?.failures ?? 0) + 1,
        updatedAt: now,
        lastError: error.slice(0, 500),
      }
      return structuredClone(data.circuits[key])
    })
  }

  clear(profile: ModelProfile) {
    return this.update((data) => {
      delete data.circuits[modelKey(profile)]
    })
  }
}
