import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { defaultSettings } from "../src/domain"
import { SummaryCoordinator } from "../src/summarizer"
import { SummaryQueueStore } from "../src/summary-queue"

const summary = {
  objective: "Ship",
  constraints: [],
  decisions: [],
  completed: ["A"],
  currentStep: "B",
  nextSteps: ["C"],
  modifiedFiles: ["x.ts"],
  tests: [],
  blockers: [],
  unresolvedQuestions: [],
  importantReferences: [],
}

const roots: string[] = []

afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for test state")
}

async function fixture(run: (profile: string, parentID: string) => Promise<unknown>) {
  const root = await mkdtemp(join(tmpdir(), "summary-queue-"))
  roots.push(root)
  const settings = defaultSettings()
  settings.summarizer.queueWaitTimeoutMs = 1000
  settings.summarizer.rateLimitCooldownMs = 60_000
  settings.summarizer.failureCooldownMs = 60_000
  const saved: Array<{ sessionID: string; value: any }> = []
  const parents = new Map<string, string>()
  let created = 0
  const client = {
    session: {
      messages: mock(async ({ path }: any) => ({
        data: [{ info: { id: `msg_${path.id}`, role: "user" }, parts: [{ type: "text", text: "implement" }] }],
      })),
      create: mock(async ({ body }: any) => {
        const id = `child_${++created}`
        parents.set(id, body.parentID)
        return { data: { id } }
      }),
      prompt: mock(async ({ path, body }: any) => {
        const result = await run(`${body.model.providerID}/${body.model.modelID}`, parents.get(path.id) ?? "")
        return result ?? { data: { parts: [{ type: "text", text: JSON.stringify(summary) }] } }
      }),
      abort: mock(async () => ({})),
      delete: mock(async () => ({})),
    },
  }
  const ledger: any = {
    get: async (sessionID: string) => ({
      sessionID,
      turnCount: 4,
      lastUserMessageID: `msg_${sessionID}`,
      todos: [],
      completedSteps: [],
      pendingSteps: [],
      decisions: [],
      modifiedFiles: [],
      verifications: [],
    }),
  }
  const handoff: any = {
    summary: async (sessionID: string) => ({ version: 1, revision: 0, sessionID }),
    saveSummary: mock(async (sessionID: string, value: any) => {
      saved.push({ sessionID, value })
      return true
    }),
  }
  const queue = new SummaryQueueStore(join(root, "summary-queue.json"))
  const coordinator = new SummaryCoordinator(client, ".", async () => settings, ledger, handoff, queue)
  return { coordinator, settings, saved, client, queue }
}

describe("summary configuration", () => {
  test("does nothing when no summarizer model is configured", async () => {
    const { coordinator, settings, client, queue } = await fixture(async () => undefined)
    settings.summarizer.enabled = true
    expect(await coordinator.schedule("s")).toBe(false)
    expect(await coordinator.refresh("s")).toBe(false)
    expect(client.session.prompt).not.toHaveBeenCalled()
    expect((await queue.snapshot()).jobs).toHaveLength(0)
  })

  test("uses one configured primary without requiring a fallback", async () => {
    const { coordinator, settings, saved, client } = await fixture(async () => undefined)
    settings.summarizer.enabled = true
    settings.summarizer.primary = { providerID: "primary", modelID: "free" }
    expect(await coordinator.refresh("s")).toBe(true)
    expect(client.session.prompt).toHaveBeenCalledTimes(1)
    expect(saved.at(-1)?.value.generatedBy.slot).toBe("primary")
  })
})

describe("summary fallback and circuits", () => {
  test("falls back immediately after one rate-limited primary attempt", async () => {
    const { coordinator, settings, saved, client } = await fixture(async (profile) => {
      if (profile === "primary/free") throw new Error("429 FreeUsageLimitError")
    })
    settings.summarizer.enabled = true
    settings.summarizer.primary = { providerID: "primary", modelID: "free" }
    settings.summarizer.fallback = { providerID: "fallback", modelID: "free-2" }
    expect(await coordinator.refresh("s")).toBe(true)
    expect(client.session.prompt).toHaveBeenCalledTimes(2)
    expect(saved.at(-1)?.value.generatedBy.slot).toBe("fallback")
    expect(saved.at(-1)?.value.primaryFailure.category).toBe("rate_limit")
  })

  test("skips a cooling primary for later sessions and persists the circuit", async () => {
    const profiles: string[] = []
    const { coordinator, settings, client, queue } = await fixture(async (profile) => {
      profiles.push(profile)
      if (profile === "primary/free") throw new Error("Free usage exceeded")
    })
    settings.summarizer.enabled = true
    settings.summarizer.primary = { providerID: "primary", modelID: "free" }
    settings.summarizer.fallback = { providerID: "fallback", modelID: "free-2" }
    expect(await coordinator.refresh("first")).toBe(true)
    expect(await coordinator.refresh("second")).toBe(true)
    expect(profiles).toEqual(["primary/free", "fallback/free-2", "fallback/free-2"])
    expect((await new SummaryQueueStore(queue.path).snapshot()).circuits["primary/free"]?.category).toBe("rate_limit")
    expect(client.session.prompt).toHaveBeenCalledTimes(3)
  })

  test("defers persistently after one failed attempt when no fallback exists", async () => {
    const { coordinator, settings, client, queue } = await fixture(async () => {
      throw new Error("429 rate limit")
    })
    settings.summarizer.enabled = true
    settings.summarizer.primary = { providerID: "primary", modelID: "free" }
    expect(await coordinator.refresh("s")).toBe(false)
    expect(client.session.prompt).toHaveBeenCalledTimes(1)
    const persisted = await new SummaryQueueStore(queue.path).snapshot()
    expect(persisted.jobs).toHaveLength(1)
    expect(persisted.jobs[0].state).toBe("waiting")
    expect(persisted.jobs[0].nextAttemptAt).toBeGreaterThan(Date.now())
    const retryAt = persisted.jobs[0].nextAttemptAt
    await coordinator.schedule("s")
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(client.session.prompt).toHaveBeenCalledTimes(1)
    expect((await queue.snapshot()).jobs[0].nextAttemptAt).toBe(retryAt)
  })
})

describe("summary queue", () => {
  test("allows only one global claim across coordinator owners", async () => {
    const root = await mkdtemp(join(tmpdir(), "summary-queue-owners-"))
    roots.push(root)
    const queue = new SummaryQueueStore(join(root, "summary-queue.json"))
    await queue.put("first", "routine", true)
    await queue.put("second", "emergency", true)

    const first = await queue.claim("owner-a", 60_000)
    expect(first?.sessionID).toBe("second")
    expect(await queue.claim("owner-b", 60_000)).toBeUndefined()

    await queue.complete(first!.id, "owner-a")
    expect((await queue.claim("owner-b", 60_000))?.sessionID).toBe("first")
  })

  test("serializes sessions without blocking the caller that schedules behind an active request", async () => {
    let release = () => {}
    const first = new Promise<void>((resolve) => {
      release = resolve
    })
    const started: string[] = []
    const { coordinator, settings, client } = await fixture(async (_profile, parentID) => {
      started.push(parentID)
      if (parentID === "first") await first
    })
    settings.summarizer.enabled = true
    settings.summarizer.primary = { providerID: "primary", modelID: "free" }
    await coordinator.schedule("first", true)
    await waitFor(() => started.length === 1)
    await coordinator.schedule("second", true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(started).toEqual(["first"])
    release()
    await waitFor(() => started.length === 2)
    expect(started).toEqual(["first", "second"])
    expect(client.session.prompt).toHaveBeenCalledTimes(2)
  })

  test("aborts the internal retry event so the coordinator can own fallback", async () => {
    let release = (_value: unknown) => {}
    const pending = new Promise((resolve) => {
      release = resolve
    })
    const { coordinator, settings, client } = await fixture(async () => pending)
    settings.summarizer.enabled = true
    settings.summarizer.primary = { providerID: "primary", modelID: "free" }
    const refresh = coordinator.refresh("s")
    await waitFor(() => coordinator.isInternal("child_1"))
    client.session.abort.mockImplementationOnce(async () => {
      release({ data: { parts: [] } })
      return {}
    })
    expect(
      await coordinator.event({
        type: "session.status",
        properties: { sessionID: "child_1", status: { type: "retry", attempt: 1, message: "Free usage exceeded" } },
      }),
    ).toBe(true)
    expect(await refresh).toBe(false)
    expect(client.session.abort).toHaveBeenCalledTimes(1)
    expect(client.session.prompt).toHaveBeenCalledTimes(1)
  })
})
