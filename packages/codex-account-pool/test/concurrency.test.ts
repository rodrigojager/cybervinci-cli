import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AccountStore } from "../src/store"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

test("serializes concurrent account writes without lost updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "accounts-concurrent-")); roots.push(root)
  const store = new AccountStore(join(root, "accounts.json"))
  await Promise.all(Array.from({ length: 25 }, (_, index) => store.add({ accessToken: `a${index}`, refreshToken: `r${index}`, expiresAt: Date.now() + 1000, workspaceAccountID: `w${index}` })))
  expect((await store.snapshot()).accounts).toHaveLength(25)
})
