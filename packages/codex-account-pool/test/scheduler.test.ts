import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { JobStore } from "../src/scheduler"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

test("claims each due resume job only once", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobs-")); roots.push(root)
  const store = new JobStore(join(root, "jobs.json"))
  const now = Date.now()
  await store.put({ id: "j", sessionID: "s", goalActive: true, state: "waiting", resumeAt: now - 1, targetAccountID: "a", epoch: 1, agent: "build", model: { providerID: "openai", modelID: "gpt" }, attempts: 0, createdAt: now, updatedAt: now })
  const [a, b] = await Promise.all([store.claim("one", 60000), store.claim("two", 60000)])
  expect([a, b].filter(Boolean)).toHaveLength(1)
})

test("respects per-account claim limits and renews the owner lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobs-limit-")); roots.push(root)
  const store = new JobStore(join(root, "jobs.json"))
  const now = Date.now()
  for (const [id, account] of [["a1", "a"], ["a2", "a"], ["b1", "b"]] as const) await store.put({ id, sessionID: id, goalActive: true, state: "waiting", resumeAt: now - 1, targetAccountID: account, epoch: 1, agent: "build", model: { providerID: "openai", modelID: "gpt" }, attempts: 0, createdAt: now, updatedAt: now })
  const first = await store.claim("owner", 10000)
  expect(first?.targetAccountID).toBe("a")
  const second = await store.claim("owner", 10000, new Set(["a"]))
  expect(second?.targetAccountID).toBe("b")
  const before = first!.owner!.leaseUntil
  await new Promise((resolve) => setTimeout(resolve, 2))
  expect(await store.renew(first!.id, "owner", 20000)).toBe(true)
  expect((await store.snapshot()).jobs.find((item) => item.id === first!.id)!.owner!.leaseUntil).toBeGreaterThan(before)
})

test("deduplicates repeated waits and reuses an in-flight job for the session", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobs-dedupe-")); roots.push(root)
  const store = new JobStore(join(root, "jobs.json"))
  const now = Date.now()
  await store.put({ id: "resume:s:1", sessionID: "s", goalActive: true, state: "waiting", resumeAt: now - 1, targetAccountID: "a", epoch: 1, agent: "build", model: { providerID: "openai", modelID: "old" }, attempts: 2, createdAt: now - 100, updatedAt: now - 100, lastError: "old failure" })
  const updated = await store.put({ id: "resume:s:2", sessionID: "s", goalActive: true, state: "waiting", resumeAt: now + 1000, targetAccountID: "b", epoch: 2, agent: "plan", model: { providerID: "openai", modelID: "new", variant: "high" }, attempts: 0, createdAt: now, updatedAt: now })

  expect(updated.id).toBe("resume:s:1")
  expect(updated).toMatchObject({ epoch: 2, targetAccountID: "b", agent: "plan", model: { modelID: "new", variant: "high" }, attempts: 0 })
  expect(updated.lastError).toBeUndefined()
  expect((await store.snapshot()).jobs.filter((item) => ["waiting", "claimed", "resuming"].includes(item.state))).toHaveLength(1)

  await store.finish(updated.id, "waiting", { resumeAt: now - 1 })
  const claimed = await store.claim("owner", 60_000)
  const reused = await store.put({ id: "resume:s:3", sessionID: "s", goalActive: true, state: "waiting", resumeAt: now + 2000, targetAccountID: "c", epoch: 3, agent: "build", model: { providerID: "openai", modelID: "newest" }, attempts: 0, createdAt: now, updatedAt: now })
  const snapshot = await store.snapshot()

  expect(reused.id).toBe(claimed!.id)
  expect(reused.state).toBe("claimed")
  expect(snapshot.jobs.filter((item) => ["waiting", "claimed", "resuming"].includes(item.state))).toHaveLength(1)
  expect(snapshot.jobs.some((item) => item.id === "resume:s:3")).toBe(false)
})

test("claim cleans legacy duplicate waiters and prefers the highest epoch", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobs-legacy-")); roots.push(root)
  const path = join(root, "jobs.json")
  const store = new JobStore(path)
  const now = Date.now()
  const waiting = (id: string, sessionID: string, epoch: number) => ({ id, sessionID, goalActive: true, state: "waiting" as const, resumeAt: now - 1, targetAccountID: "a", epoch, agent: "build", model: { providerID: "openai", modelID: "gpt" }, attempts: 0, createdAt: now - epoch, updatedAt: now - epoch })
  await writeFile(path, JSON.stringify({
    version: 1,
    revision: 0,
    jobs: [
      waiting("old", "waiters", 1),
      waiting("newest", "waiters", 3),
      waiting("middle", "waiters", 2),
      { ...waiting("active", "in-flight", 1), state: "claimed", owner: { instanceID: "existing", pid: process.pid, hostname: "host", leaseUntil: now + 60_000 } },
      waiting("active-duplicate", "in-flight", 4),
    ],
  }))

  const claimed = await store.claim("owner", 60_000)
  const snapshot = await store.snapshot()
  const waiterJobs = snapshot.jobs.filter((item) => item.sessionID === "waiters")
  const inFlightJobs = snapshot.jobs.filter((item) => item.sessionID === "in-flight")

  expect(claimed?.id).toBe("newest")
  expect(waiterJobs.find((item) => item.id === "newest")?.state).toBe("claimed")
  expect(waiterJobs.filter((item) => item.state === "cancelled")).toHaveLength(2)
  expect(inFlightJobs.find((item) => item.id === "active")?.state).toBe("claimed")
  expect(inFlightJobs.find((item) => item.id === "active-duplicate")?.state).toBe("cancelled")
})
