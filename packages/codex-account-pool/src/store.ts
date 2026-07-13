import { randomUUID } from "node:crypto"
import { readFile, rename } from "node:fs/promises"
import { z } from "zod"
import { accountSchema, accountsFileSchema, type Account, type AccountQuota, type AccountsFile } from "./domain"
import { atomicWrite, paths, readJson, transact } from "./storage"

const emptyAccounts = (): AccountsFile => ({ version: 2, initialized: false, revision: 0, order: [], accounts: [] })

const legacySchema = z.object({
  version: z.literal(1),
  initialized: z.boolean().default(false),
  active: z.string().optional(),
  order: z.array(z.string()).default([]),
  accounts: z.array(z.object({
    id: z.string(), label: z.string(), email: z.string().optional(), accountId: z.string().optional(),
    access: z.string(), refresh: z.string(), expires: z.number(), enabled: z.boolean(), createdAt: z.number(), updatedAt: z.number(),
    health: z.object({ successes: z.number(), failures: z.number(), cooldownUntil: z.number().optional(), lastStatus: z.number().optional(), lastErrorAt: z.number().optional() }),
  })),
})

export interface AccountInput {
  accessToken: string
  refreshToken: string
  expiresAt: number
  label?: string
  email?: string
  subjectID?: string
  workspaceAccountID?: string
  organizationID?: string
  planType?: string
}

export class AccountStore {
  constructor(readonly path = paths.accounts) {}

  private async migrate() {
    try {
      return await readJson(this.path, accountsFileSchema, emptyAccounts)
    } catch (error) {
      const raw = JSON.parse(await readFile(this.path, "utf8"))
      const legacy = legacySchema.safeParse(raw)
      if (!legacy.success) throw error
      const migrated: AccountsFile = {
        version: 2,
        initialized: legacy.data.initialized,
        revision: 1,
        defaultAccountID: legacy.data.active,
        order: legacy.data.order,
        accounts: legacy.data.accounts.map((item) => accountSchema.parse({
          id: item.id, label: item.label, email: item.email, workspaceAccountID: item.accountId,
          accessToken: item.access, refreshToken: item.refresh, expiresAt: item.expires,
          enabled: item.enabled, createdAt: item.createdAt, updatedAt: item.updatedAt, health: item.health,
        })),
      }
      await atomicWrite(`${this.path}.v1.backup`, raw, true)
      await atomicWrite(this.path, migrated, true)
      return migrated
    }
  }

  async importLegacyIfNeeded() {
    const current = await this.migrate()
    if (current.initialized || current.accounts.length || this.path === paths.legacyAccounts) return current
    try {
      const raw = JSON.parse(await readFile(paths.legacyAccounts, "utf8"))
      const legacy = legacySchema.parse(raw)
      await atomicWrite(this.path, {
        version: 1,
        initialized: legacy.initialized,
        active: legacy.active,
        order: legacy.order,
        accounts: legacy.accounts,
      }, true)
      const migrated = await this.migrate()
      await rename(paths.legacyAccounts, `${paths.legacyAccounts}.migrated`).catch(() => {})
      return migrated
    } catch {
      return current
    }
  }

  async snapshot() {
    return this.migrate()
  }

  private update<R>(fn: (data: AccountsFile) => R | Promise<R>) {
    return transact({
      key: "accounts", path: this.path, schema: accountsFileSchema, fallback: emptyAccounts, secret: true,
      async update(data) {
        const result = await fn(data)
        data.revision++
        return result
      },
    })
  }

  async initialize() {
    await this.importLegacyIfNeeded()
    return this.update((data) => {
      const previous = data.initialized
      data.initialized = true
      return previous
    })
  }

  async add(input: AccountInput | { access: string; refresh: string; expires: number; accountId?: string; email?: string; label?: string }) {
    const normalized: AccountInput = "access" in input
      ? { accessToken: input.access, refreshToken: input.refresh, expiresAt: input.expires, workspaceAccountID: input.accountId, email: input.email, label: input.label }
      : input
    return this.update((data) => {
      const account = data.accounts.find((item) =>
        Boolean(normalized.subjectID && normalized.workspaceAccountID && item.subjectID === normalized.subjectID && item.workspaceAccountID === normalized.workspaceAccountID) ||
        Boolean(normalized.workspaceAccountID && item.workspaceAccountID === normalized.workspaceAccountID) ||
        Boolean(normalized.workspaceAccountID && normalized.email && item.workspaceAccountID === normalized.workspaceAccountID && item.email === normalized.email) ||
        item.refreshToken === normalized.refreshToken,
      )
      const now = Date.now()
      if (account) {
        Object.assign(account, Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined)), { updatedAt: now, enabled: true })
        if (normalized.label) account.label = normalized.label
        data.defaultAccountID = account.id
        data.order = [account.id, ...data.order.filter((id) => id !== account.id)]
        data.initialized = true
        return structuredClone(account)
      }
      const next: Account = accountSchema.parse({
        id: randomUUID(),
        ...normalized,
        label: normalized.label ?? normalized.email ?? `Conta ${data.accounts.length + 1}`,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        health: { successes: 0, failures: 0 },
      })
      data.accounts.push(next)
      data.order.push(next.id)
      data.defaultAccountID = next.id
      data.initialized = true
      return structuredClone(next)
    })
  }

  async updateTokens(id: string, input: Partial<Pick<Account, "accessToken" | "refreshToken" | "expiresAt" | "workspaceAccountID" | "email" | "subjectID">> & { access?: string; refresh?: string; expires?: number; accountId?: string }) {
    return this.update((data) => {
      const account = data.accounts.find((item) => item.id === id)
      if (!account) return false
      if (input.access !== undefined) account.accessToken = input.access
      if (input.refresh !== undefined) account.refreshToken = input.refresh
      if (input.expires !== undefined) account.expiresAt = input.expires
      if (input.accountId !== undefined) account.workspaceAccountID = input.accountId
      Object.assign(account, Object.fromEntries(Object.entries(input).filter(([key]) => !["access", "refresh", "expires", "accountId"].includes(key))))
      account.updatedAt = Date.now()
      return true
    })
  }

  async renameAccount(id: string, label: string) {
    return this.update((data) => {
      const account = data.accounts.find((item) => item.id === id)
      if (!account) return false
      account.label = label.trim().slice(0, 80)
      account.updatedAt = Date.now()
      return true
    })
  }

  async setDefault(id: string) {
    return this.update((data) => {
      if (!data.accounts.some((item) => item.id === id)) return false
      data.defaultAccountID = id
      data.order = [id, ...data.order.filter((item) => item !== id)]
      return true
    })
  }

  async setActive(id: string) { return this.setDefault(id) }

  async setEnabled(id: string, enabled: boolean) {
    return this.update((data) => {
      const account = data.accounts.find((item) => item.id === id)
      if (!account) return false
      account.enabled = enabled
      account.updatedAt = Date.now()
      return true
    })
  }

  async remove(id: string) {
    return this.update((data) => {
      const before = data.accounts.length
      data.accounts = data.accounts.filter((item) => item.id !== id)
      data.order = data.order.filter((item) => item !== id)
      if (data.defaultAccountID === id) data.defaultAccountID = data.order.find((item) => data.accounts.some((account) => account.id === item && account.enabled))
      return before !== data.accounts.length
    })
  }

  async recordOutcome(id: string, status: number, ok: boolean, cooldownUntil?: number) {
    return this.update((data) => {
      const account = data.accounts.find((item) => item.id === id)
      if (!account) return
      account.health.successes += ok ? 1 : 0
      account.health.failures += ok ? 0 : 1
      account.health.lastStatus = status
      account.health.lastErrorAt = ok ? undefined : Date.now()
      account.health.cooldownUntil = ok ? undefined : cooldownUntil
      account.lastUsedAt = ok ? Date.now() : account.lastUsedAt
      account.updatedAt = Date.now()
    })
  }

  async outcome(id: string, status: number, ok: boolean, cooldownUntil?: number) { return this.recordOutcome(id, status, ok, cooldownUntil) }

  async updateQuota(id: string, quota: AccountQuota) {
    return this.update((data) => {
      const account = data.accounts.find((item) => item.id === id)
      if (!account) return false
      account.quota = quota
      if (quota.planType !== undefined) account.planType = quota.planType
      account.updatedAt = Date.now()
      return true
    })
  }

  async moveToBack(id: string) {
    return this.update((data) => {
      data.order = [...data.order.filter((item) => item !== id), id]
      if (data.defaultAccountID === id) data.defaultAccountID = data.order.find((item) => data.accounts.some((account) => account.id === item && account.enabled))
    })
  }
}

export type { Account }
