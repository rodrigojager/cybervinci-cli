import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AccountActionStore } from "../src/actions"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

test("deduplicates removals and reclaims expired action leases", async () => {
  const root = await mkdtemp(join(tmpdir(), "actions-")); roots.push(root)
  const store = new AccountActionStore(join(root, "actions.json"))
  const first = await store.enqueueRemove("account")
  expect((await store.enqueueRemove("account")).id).toBe(first.id)
  expect((await store.claim("dead", -1))?.id).toBe(first.id)
  expect((await store.claim("live", 60000))?.owner).toBe("live")
})
