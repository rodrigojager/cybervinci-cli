import { describe, expect, mock, test } from "bun:test"
import { defaultSettings } from "../src/domain"
import { SummaryCoordinator } from "../src/summarizer"

const summary = { objective: "Ship", constraints: [], decisions: [], completed: ["A"], currentStep: "B", nextSteps: ["C"], modifiedFiles: ["x.ts"], tests: [], blockers: [], unresolvedQuestions: [], importantReferences: [] }

function fixture(fallbackFails = false) {
  let created = 0
  const saved: any[] = []
  const client = { session: {
    messages: mock(async () => ({ data: [{ info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "implement" }] }] })),
    create: mock(async () => ({ data: { id: `child_${++created}` } })),
    prompt: mock(async ({ path }: any) => {
      if (path.id === "child_1" || fallbackFails) throw new Error(path.id === "child_1" ? "429 rate limit" : "fallback timeout")
      return { data: { parts: [{ type: "text", text: JSON.stringify(summary) }] } }
    }),
    delete: mock(async () => ({})),
  } }
  const ledger: any = { get: async () => ({ sessionID: "s", turnCount: 4, todos: [], completedSteps: [], pendingSteps: [], decisions: [], modifiedFiles: [], verifications: [] }) }
  const handoff: any = { summary: async () => ({ version: 1, revision: 0, sessionID: "s" }), saveSummary: mock(async (_sessionID: string, value: any) => { saved.push(value); return true }) }
  return { coordinator: new SummaryCoordinator(client, ".", ledger, handoff), saved, client }
}

describe("summary fallback", () => {
  test("uses configured fallback after a categorized primary failure", async () => {
    const { coordinator, saved, client } = fixture()
    const settings = defaultSettings()
    settings.summarizer.enabled = true
    settings.summarizer.primary = { providerID: "primary", modelID: "p" }
    settings.summarizer.fallback = { providerID: "fallback", modelID: "f", variant: "low" }
    await coordinator.refresh("s", settings)
    expect(client.session.prompt).toHaveBeenCalledTimes(2)
    expect(saved.at(-1).generatedBy.slot).toBe("fallback")
    expect(saved.at(-1).summary.objective).toBe("Ship")
  })

  test("keeps diagnostics without advancing summary when both profiles fail", async () => {
    const { coordinator, saved } = fixture(true)
    const settings = defaultSettings()
    settings.summarizer.enabled = true
    settings.summarizer.primary = { providerID: "primary", modelID: "p" }
    settings.summarizer.fallback = { providerID: "fallback", modelID: "f" }
    await coordinator.refresh("s", settings)
    expect(saved.at(-1).lastError).toContain("fallback timeout")
    expect(saved.at(-1).summary).toBeUndefined()
  })
})
