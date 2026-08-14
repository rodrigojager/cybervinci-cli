import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AccountStore } from "../src/store"

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function store() {
  const directory = await mkdtemp(join(tmpdir(), "codex-pool-"))
  directories.push(directory)
  return new AccountStore(join(directory, "accounts.json"))
}

describe("AccountStore", () => {
  test("adds, deduplicates and activates accounts", async () => {
    const target = await store()
    const first = await target.add({ access: "a", refresh: "r", expires: 1, accountId: "workspace", email: "a@b.c" })
    const updated = await target.add({ access: "b", refresh: "r2", expires: 2, accountId: "workspace" })
    const snapshot = await target.snapshot()

    expect(updated.id).toBe(first.id)
    expect(snapshot.accounts).toHaveLength(1)
    expect(snapshot.accounts[0].accessToken).toBe("b")
    expect(snapshot.defaultAccountID).toBe(first.id)
  })

  test("moves failed accounts behind healthy accounts", async () => {
    const target = await store()
    const first = await target.add({ access: "a", refresh: "r1", expires: 1 })
    const second = await target.add({ access: "b", refresh: "r2", expires: 1 })
    await target.setActive(first.id)
    await target.moveToBack(first.id)
    const snapshot = await target.snapshot()

    expect(snapshot.order).toEqual([second.id, first.id])
    expect(snapshot.defaultAccountID).toBe(second.id)
  })

  test("keeps distinct ChatGPT workspaces as separate pool accounts", async () => {
    const target = await store()
    const first = await target.add({ access: "a", refresh: "r1", expires: 1, accountId: "workspace-1" })
    const second = await target.add({ access: "b", refresh: "r2", expires: 1, accountId: "workspace-2" })
    const snapshot = await target.snapshot()

    expect(second.id).not.toBe(first.id)
    expect(snapshot.accounts).toHaveLength(2)
    expect(snapshot.accounts.map((account) => account.workspaceAccountID).sort()).toEqual(["workspace-1", "workspace-2"])
  })

  test("accepts null credit balances from older quota snapshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-pool-"))
    const path = join(directory, "accounts.json")
    directories.push(directory)
    await Bun.write(path, JSON.stringify({
      version: 2,
      initialized: true,
      revision: 1,
      order: ["account"],
      accounts: [{
        id: "account",
        label: "Account",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: 1,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
        health: { successes: 0, failures: 0 },
        quota: {
          credits: { balance: null },
          fetchedAt: 1,
          source: "usage-endpoint",
        },
      }],
    }))

    const snapshot = await new AccountStore(path).snapshot()

    expect(snapshot.accounts[0].quota?.credits?.balance).toBeUndefined()
  })
})
