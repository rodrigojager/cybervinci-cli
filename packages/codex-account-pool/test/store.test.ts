import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
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

  test("persists explicit primary, secondary and tertiary account priority", async () => {
    const target = await store()
    const primary = await target.add({ access: "a", refresh: "r1", expires: 1, accountId: "workspace-a" })
    const secondary = await target.add({ access: "b", refresh: "r2", expires: 1, accountId: "workspace-b" })
    const tertiary = await target.add({ access: "c", refresh: "r3", expires: 1, accountId: "workspace-c" })

    expect((await target.snapshot()).order).toEqual([primary.id, secondary.id, tertiary.id])
    expect((await target.snapshot()).defaultAccountID).toBe(primary.id)

    await target.add({ access: "b2", refresh: "r2-new", expires: 2, accountId: "workspace-b" })
    expect((await target.snapshot()).order).toEqual([primary.id, secondary.id, tertiary.id])

    await target.setPriority(tertiary.id, 1)
    const reopened = await new AccountStore(target.path).snapshot()
    expect(reopened.order).toEqual([primary.id, tertiary.id, secondary.id])
    expect(reopened.defaultAccountID).toBe(primary.id)

    await target.setDefault(secondary.id)
    expect((await target.snapshot()).order).toEqual([secondary.id, primary.id, tertiary.id])
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

  test("reopens three accounts when the newest quota has a null credit balance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-pool-"))
    const path = join(directory, "accounts.json")
    directories.push(directory)
    const accounts = ["one", "two", "three"].map((id, index) => ({
      id,
      label: `Account ${index + 1}`,
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: Date.now() + 60_000,
      enabled: true,
      createdAt: index + 1,
      updatedAt: index + 1,
      health: { successes: 0, failures: 0 },
      ...(id === "three" ? {
        quota: {
          credits: { balance: null },
          fetchedAt: Date.now(),
          source: "usage-endpoint",
        },
      } : {}),
    }))
    await Bun.write(path, JSON.stringify({
      version: 2,
      initialized: true,
      revision: 3,
      defaultAccountID: "three",
      order: ["three", "one", "two"],
      accounts,
    }))

    await new AccountStore(path).initialize()
    const snapshot = await new AccountStore(path).snapshot()
    const persisted = JSON.parse(await readFile(path, "utf8"))

    expect(snapshot.accounts).toHaveLength(3)
    expect(snapshot.defaultAccountID).toBe("three")
    expect(snapshot.accounts[2].quota?.credits?.balance).toBeUndefined()
    expect(persisted.accounts[2].quota.credits).not.toHaveProperty("balance")
  })
})
