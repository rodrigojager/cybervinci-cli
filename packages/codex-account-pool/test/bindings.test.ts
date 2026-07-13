import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BindingStore, earliestAccount, selectAccount } from "../src/bindings"
import type { Account } from "../src/domain"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))))
const account = (id: string, used: number, resetAt?: number): Account => ({ id, label: id, accessToken: id, refreshToken: id, expiresAt: Date.now() + 1000, enabled: true, createdAt: 1, updatedAt: 1, health: { successes: 0, failures: 0 }, quota: { primary: { usedPercent: used, resetAt }, fetchedAt: Date.now(), source: "usage-endpoint" } })

describe("session bindings", () => {
  test("isolates accounts and epochs by session", async () => {
    const root = await mkdtemp(join(tmpdir(), "bindings-")); roots.push(root)
    const store = new BindingStore(join(root, "bindings.json"))
    await Promise.all([store.bind("ses_a", "a", { epoch: 1 }), store.bind("ses_b", "b", { epoch: 3 })])
    expect((await store.get("ses_a"))?.accountID).toBe("a")
    expect((await store.get("ses_b"))?.epoch).toBe(3)
  })

  test("prefers sticky healthy account and earliest reset when exhausted", () => {
    const now = Date.now()
    expect(selectAccount([account("a", 10), account("b", 5)], "a")?.id).toBe("a")
    expect(earliestAccount([account("a", 100, now + 5000), account("b", 100, now + 1000)], now)?.account.id).toBe("b")
  })
})
