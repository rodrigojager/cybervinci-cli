import { describe, expect, test } from "bun:test"
import { applyEpoch, handoffText } from "../src/handoff"

const message = (id: string, role: "user" | "assistant", text: string) => ({ info: { id, sessionID: "ses_a", role }, parts: [{ id: `p_${id}`, messageID: id, sessionID: "ses_a", type: "text", text }] })

describe("handoff epochs", () => {
  test("permanently replaces old history with checkpoint and retained tail", () => {
    const messages = [message("001", "user", "old goal"), message("002", "assistant", "old work"), message("003", "user", "latest request"), message("004", "assistant", "latest result"), message("005", "user", "continue")]
    const result = applyEpoch(structuredClone(messages), "004", "HANDOFF", 1)
    expect(result.some((item) => item.info.id === "001")).toBe(false)
    expect(result.some((item) => item.info.id === "003")).toBe(true)
    expect(result.find((item) => item.info.role === "user")?.parts[0].text).toBe("HANDOFF")
  })

  test("renders concise structured state", () => {
    const text = handoffText({ objective: "Ship feature", plan: { completed: ["A"], current: "B", pending: ["C"] }, decisions: ["JSON"], blockers: [], modifiedFiles: ["x.ts"], lastMilestone: "A" })
    expect(text).toContain("Ship feature")
    expect(text).toContain("Current step: B")
  })
})
