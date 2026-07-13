import { randomUUID } from "node:crypto"
import { accountActionsFileSchema, type AccountAction } from "./domain"
import { paths, readJson, transact } from "./storage"

const empty = () => ({ version: 1 as const, revision: 0, actions: [] as AccountAction[] })
export class AccountActionStore {
  constructor(readonly path = paths.actions) {}
  async snapshot() { return readJson(this.path, accountActionsFileSchema, empty) }
  private update<R>(fn: (data: ReturnType<typeof empty>) => R | Promise<R>) { return transact({ key: `actions:${this.path}`, path: this.path, schema: accountActionsFileSchema, fallback: empty, async update(data) { const result = await fn(data); data.revision++; return result } }) }
  async enqueueRemove(accountID: string) { const now = Date.now(); return this.update((data) => { const existing = data.actions.find((item) => item.accountID === accountID && item.type === "remove" && ["pending", "claimed"].includes(item.state)); if (existing) return existing; const action: AccountAction = { id: randomUUID(), type: "remove", accountID, state: "pending", createdAt: now, updatedAt: now }; data.actions.push(action); return action }) }
  async claim(owner: string, leaseMs = 60000) { return this.update((data) => { const now = Date.now(); for (const item of data.actions) if (item.state === "claimed" && (item.leaseUntil ?? 0) <= now) { item.state = "pending"; item.owner = undefined; item.leaseUntil = undefined }; const action = data.actions.find((item) => item.state === "pending"); if (!action) return; action.state = "claimed"; action.owner = owner; action.leaseUntil = now + leaseMs; action.updatedAt = now; return structuredClone(action) }) }
  async finish(id: string, state: "completed" | "failed", result: string) { return this.update((data) => { const action = data.actions.find((item) => item.id === id); if (!action) return; action.state = state; action.owner = undefined; action.leaseUntil = undefined; action.result = result; action.updatedAt = Date.now(); return action }) }
  async requeue(id: string, result: string) { return this.update((data) => { const action = data.actions.find((item) => item.id === id); if (!action) return; action.state = "pending"; action.owner = undefined; action.leaseUntil = undefined; action.result = result; action.updatedAt = Date.now(); return action }) }
}
