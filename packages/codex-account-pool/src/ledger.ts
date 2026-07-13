import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { ledgerSchema, type SessionLedger } from "./domain"
import { paths, readJson, transact } from "./storage"

const empty = (sessionID: string): SessionLedger => ({
  version: 1, revision: 0, sessionID, todos: [], completedSteps: [], pendingSteps: [], decisions: [], modifiedFiles: [], verifications: [], turnCount: 0, updatedAt: Date.now(),
})

export class LedgerStore {
  path(sessionID: string) { return join(paths.session(sessionID), "ledger.json") }
  async get(sessionID: string) { return readJson(this.path(sessionID), ledgerSchema, () => empty(sessionID)) }
  private update<R>(sessionID: string, fn: (ledger: SessionLedger) => R | Promise<R>) {
    return transact({ key: `session:${sessionID}:ledger`, path: this.path(sessionID), schema: ledgerSchema, fallback: () => empty(sessionID), async update(ledger) {
      const result = await fn(ledger); ledger.revision++; ledger.updatedAt = Date.now(); return result
    } })
  }

  async setGoal(sessionID: string, input: Partial<NonNullable<SessionLedger["goal"]>> & { objective?: string; status?: NonNullable<SessionLedger["goal"]>["status"] }) {
    return this.update(sessionID, (ledger) => {
      const previous = ledger.goal
      if (!previous && !input.objective) return
      ledger.goal = {
        id: input.id ?? previous?.id,
        objective: input.objective ?? previous?.objective ?? "",
        status: input.status ?? previous?.status ?? "active",
        lastCheckpoint: input.lastCheckpoint ?? previous?.lastCheckpoint,
        updatedAt: Date.now(),
      }
    })
  }

  async setTodos(sessionID: string, todos: Array<{ content: string; status: string; priority?: string }>) {
    return this.update(sessionID, (ledger) => {
      const previousCompleted = new Set(ledger.todos.filter((item) => item.status === "completed").map((item) => item.content))
      ledger.todos = todos.map((item) => ({ ...item }))
      for (const item of todos) if (item.status === "completed" && !previousCompleted.has(item.content)) ledger.completedSteps.push(item.content)
      ledger.completedSteps = [...new Set(ledger.completedSteps)].slice(-100)
      ledger.currentStep = todos.find((item) => item.status === "in_progress")?.content
      ledger.pendingSteps = todos.filter((item) => item.status === "pending").map((item) => item.content)
    })
  }

  async note(sessionID: string, category: string, text: string, replaceKey?: string) {
    return this.update(sessionID, (ledger) => {
      if (replaceKey) ledger.decisions = ledger.decisions.filter((item) => item.replaceKey !== replaceKey)
      ledger.decisions.push({ id: randomUUID(), category, text: text.trim().slice(0, 4000), replaceKey, createdAt: Date.now() })
      ledger.decisions = ledger.decisions.slice(-100)
    })
  }

  async file(sessionID: string, path: string) { return this.update(sessionID, (ledger) => { ledger.modifiedFiles = [...new Set([...ledger.modifiedFiles, path])].slice(-500) }) }
  async verification(sessionID: string, command: string, result: string) { return this.update(sessionID, (ledger) => { ledger.verifications.push({ command: command.slice(0, 500), result: result.slice(0, 1000), at: Date.now() }); ledger.verifications = ledger.verifications.slice(-50) }) }
  async userMessage(sessionID: string, messageID: string | undefined, text: string) { return this.update(sessionID, (ledger) => { ledger.lastUserMessageID = messageID; ledger.lastUserText = text.slice(0, 8000); ledger.turnCount++ }) }
  async assistant(sessionID: string, messageID: string) { return this.update(sessionID, (ledger) => { ledger.lastAssistantMessageID = messageID }) }
}
