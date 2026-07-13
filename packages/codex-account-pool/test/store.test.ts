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
})
