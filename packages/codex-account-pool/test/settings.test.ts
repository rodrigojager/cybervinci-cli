import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SettingsStore } from "../src/config"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

test("persists global primary and optional fallback with revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "settings-")); roots.push(root)
  const store = new SettingsStore(join(root, "settings.json"))
  const initial = await store.get()
  initial.summarizer.enabled = true
  initial.summarizer.primary = { providerID: "opencode", modelID: "free", variant: "low" }
  initial.summarizer.fallback = { providerID: "omniroute", modelID: "cheap", variant: "medium" }
  const saved = await store.save(initial)
  expect(saved.revision).toBe(1)
  expect((await new SettingsStore(store.path).get()).summarizer.fallback?.providerID).toBe("omniroute")
})
