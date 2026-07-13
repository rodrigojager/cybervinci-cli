import { join } from "node:path"
import { epochSchema, sessionStateSchema, summaryFileSchema, type Account, type ContextEpoch, type SessionLedger, type SessionState, type StructuredSummary, type SummaryFile } from "./domain"
import { paths, atomicWrite, readJson, transact } from "./storage"

const emptySummary = (sessionID: string): SummaryFile => ({ version: 1, revision: 0, sessionID })
const emptyState = (sessionID: string): SessionState => ({ version: 1, revision: 0, sessionID, status: "active", updatedAt: Date.now() })

export class HandoffStore {
  summaryPath(sessionID: string) { return join(paths.session(sessionID), "summary.json") }
  statePath(sessionID: string) { return join(paths.session(sessionID), "state.json") }
  async summary(sessionID: string) { return readJson(this.summaryPath(sessionID), summaryFileSchema, () => emptySummary(sessionID)) }
  async state(sessionID: string) { return readJson(this.statePath(sessionID), sessionStateSchema, () => emptyState(sessionID)) }

  async saveSummary(sessionID: string, input: Omit<SummaryFile, "version" | "revision" | "sessionID">, expectedBase?: string) {
    return transact({ key: `session:${sessionID}:summary`, path: this.summaryPath(sessionID), schema: summaryFileSchema, fallback: () => emptySummary(sessionID), update(current) {
      if (expectedBase && current.basedOnMessageID && current.basedOnMessageID > expectedBase) return false
      Object.assign(current, input); current.revision++; return true
    } })
  }

  async setEpoch(sessionID: string, epoch: ContextEpoch, status: SessionState["status"] = "active") {
    return transact({ key: `session:${sessionID}:state`, path: this.statePath(sessionID), schema: sessionStateSchema, fallback: () => emptyState(sessionID), update(current) {
      current.epoch = epochSchema.parse(epoch); current.status = status; current.revision++; current.updatedAt = Date.now(); return current
    } })
  }

  async commitEpoch(sessionID: string, epochNumber: number) {
    return transact({ key: `session:${sessionID}:state`, path: this.statePath(sessionID), schema: sessionStateSchema, fallback: () => emptyState(sessionID), update(current) {
      if (!current.epoch || current.epoch.epoch !== epochNumber) return false
      current.epoch.state = "committed"; current.epoch.committedAt = Date.now(); current.status = "active"; current.revision++; current.updatedAt = Date.now(); return true
    } })
  }

  async checkpoint(input: { sessionID: string; source?: Account; target: Account; ledger: SessionLedger; summary?: StructuredSummary; cutoffMessageID: string; reason: string; quota?: unknown }) {
    const state = await this.state(input.sessionID)
    const epochNumber = (state.epoch?.epoch ?? 0) + 1
    const path = join(paths.session(input.sessionID), "handoffs", `epoch-${epochNumber}.json`)
    const checkpoint = {
      version: 1, sessionID: input.sessionID, epoch: epochNumber, createdAt: Date.now(), reason: input.reason,
      sourceAccount: input.source && { id: input.source.id, label: input.source.label, email: input.source.email },
      targetAccount: { id: input.target.id, label: input.target.label, email: input.target.email },
      objective: input.ledger.goal?.objective ?? input.summary?.objective ?? input.ledger.lastUserText ?? "",
      plan: { completed: input.ledger.completedSteps, current: input.ledger.currentStep, pending: input.ledger.pendingSteps },
      decisions: [...(input.summary?.decisions ?? []), ...input.ledger.decisions.map((item) => item.text)],
      constraints: input.summary?.constraints ?? [], blockers: input.summary?.blockers ?? [], modifiedFiles: input.ledger.modifiedFiles,
      tests: input.ledger.verifications.map((item) => `${item.command}: ${item.result}`), lastMilestone: input.ledger.completedSteps.at(-1),
      quota: input.quota, boundary: { cutoffMessageID: input.cutoffMessageID, lastUserMessageID: input.ledger.lastUserMessageID, lastAssistantMessageID: input.ledger.lastAssistantMessageID },
      summary: input.summary,
    }
    await atomicWrite(path, checkpoint)
    const epoch: ContextEpoch = { sessionID: input.sessionID, epoch: epochNumber, sourceAccountID: input.source?.id, targetAccountID: input.target.id, cutoffMessageID: input.cutoffMessageID, summaryRevision: (await this.summary(input.sessionID)).revision, checkpointPath: path, state: "armed", reason: input.reason, createdAt: Date.now() }
    await this.setEpoch(input.sessionID, epoch)
    return { checkpoint, epoch }
  }
}

export function handoffText(checkpoint: any) {
  const lines = [
    "# Session Handoff", "", "Continue the existing task from this structured state. Earlier transcript was intentionally omitted.",
    "The local workspace, goal, todos, and tool results after this handoff are authoritative. Do not repeat completed work.", "",
    `Objective: ${checkpoint.objective || "Not recorded"}`,
    `Completed: ${(checkpoint.plan?.completed ?? []).join(" | ") || "None recorded"}`,
    `Current step: ${checkpoint.plan?.current ?? "Not recorded"}`,
    `Next steps: ${(checkpoint.plan?.pending ?? []).join(" | ") || "None recorded"}`,
    `Decisions: ${(checkpoint.decisions ?? []).join(" | ") || "None recorded"}`,
    `Blockers: ${(checkpoint.blockers ?? []).join(" | ") || "None"}`,
    `Modified files: ${(checkpoint.modifiedFiles ?? []).join(", ") || "None recorded"}`,
    `Last milestone: ${checkpoint.lastMilestone ?? "Not recorded"}`,
  ]
  return lines.join("\n").slice(0, 24000)
}

export function applyEpoch(messages: any[], cutoffMessageID: string, text: string, retainLastTurns = 1) {
  const after = messages.filter((message) => String(message.info?.id ?? "") > cutoffMessageID)
  const before = messages.filter((message) => String(message.info?.id ?? "") <= cutoffMessageID)
  const retained: any[] = []
  let turns = 0
  for (let index = before.length - 1; index >= 0 && turns < retainLastTurns; index--) {
    retained.unshift(before[index])
    if (before[index]?.info?.role === "user") turns++
  }
  const result = [...retained, ...after]
  const target = result.find((message) => message.info?.role === "user") ?? result[0]
  if (target) target.parts = [{ id: `prt_handoff_${Date.now()}`, messageID: target.info.id, sessionID: target.info.sessionID, type: "text", text, synthetic: true }, ...(target.parts ?? [])]
  return result
}
