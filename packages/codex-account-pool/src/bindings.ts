import { bindingsFileSchema, type Account, type SessionBinding } from "./domain"
import { paths, readJson, transact } from "./storage"
import { blockedUntil, headroom } from "./quota"
import { randomUUID } from "node:crypto"
import { hostname } from "node:os"

const empty = () => ({ version: 1 as const, revision: 0, bindings: {} as Record<string, SessionBinding>, reservations: [] as Array<{ id: string; accountID: string; sessionID?: string; instanceID: string; expiresAt: number; createdAt: number }> })

export class BindingStore {
  constructor(readonly path = paths.bindings) {}
  async snapshot() { return readJson(this.path, bindingsFileSchema, empty) }

  private update<R>(fn: (data: ReturnType<typeof empty>) => R | Promise<R>) {
    return transact({ key: `bindings:${this.path}`, path: this.path, schema: bindingsFileSchema, fallback: empty, async update(data) {
      const result = await fn(data)
      data.revision++
      return result
    } })
  }

  async get(sessionID: string) { return (await this.snapshot()).bindings[sessionID] }

  async bind(sessionID: string, accountID: string, input: Partial<SessionBinding> = {}) {
    return this.update((data) => {
      const previous = data.bindings[sessionID]
      const now = Date.now()
      const binding: SessionBinding = {
        sessionID, accountID, epoch: input.epoch ?? previous?.epoch ?? 0,
        worktree: input.worktree ?? previous?.worktree,
        directory: input.directory ?? previous?.directory,
        agent: input.agent ?? previous?.agent,
        model: input.model ?? previous?.model,
        pinnedByUser: input.pinnedByUser ?? previous?.pinnedByUser ?? false,
        createdAt: previous?.createdAt ?? now, updatedAt: now,
      }
      data.bindings[sessionID] = binding
      return binding
    })
  }

  async removeSession(sessionID: string) { return this.update((data) => delete data.bindings[sessionID]) }

  async affected(accountID: string) { return Object.values((await this.snapshot()).bindings).filter((item) => item.accountID === accountID) }

  async removeAccount(accountID: string) {
    return this.update((data) => {
      const affected = Object.values(data.bindings).filter((item) => item.accountID === accountID)
      for (const binding of affected) delete data.bindings[binding.sessionID]
      return affected
    })
  }

  async reserve(accountID: string, sessionID?: string, leaseMs = 10 * 60_000) {
    return this.update((data) => {
      const now = Date.now()
      data.reservations = data.reservations.filter((item) => item.expiresAt > now)
      const reservation = { id: randomUUID(), accountID, sessionID, instanceID: `${hostname()}:${process.pid}`, createdAt: now, expiresAt: now + leaseMs }
      data.reservations.push(reservation)
      return reservation
    })
  }

  async releaseReservation(id: string) { return this.update((data) => { data.reservations = data.reservations.filter((item) => item.id !== id) }) }
  async activeReservations(accountID: string) { const now = Date.now(); return (await this.snapshot()).reservations.filter((item) => item.accountID === accountID && item.expiresAt > now) }
}

export function selectAccount(accounts: Account[], preferred?: string, now = Date.now()) {
  const enabled = accounts.filter((item) => item.enabled)
  const available = enabled.filter((item) => blockedUntil(item, now) <= now && (item.health.cooldownUntil ?? 0) <= now)
  if (!available.length) return undefined
  const sticky = preferred ? available.find((item) => item.id === preferred) : undefined
  if (sticky) return sticky
  return [...available].sort((a, b) => headroom(b) - headroom(a) || (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))[0]
}

export function earliestAccount(accounts: Account[], now = Date.now()) {
  return accounts.filter((item) => item.enabled).map((account) => ({ account, at: Math.max(blockedUntil(account, now), account.health.cooldownUntil ?? 0) })).sort((a, b) => a.at - b.at)[0]
}
