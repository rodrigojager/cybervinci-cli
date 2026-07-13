import { afterEach, expect, test } from "bun:test"
import { dataRoot } from "../src/storage"

const previousCyberVinci = process.env.CYBERVINCI_CODEX_DATA_DIR
const previousOpenCode = process.env.OPENCODE_CODEX_DATA_DIR

afterEach(() => {
  if (previousCyberVinci === undefined) delete process.env.CYBERVINCI_CODEX_DATA_DIR
  else process.env.CYBERVINCI_CODEX_DATA_DIR = previousCyberVinci
  if (previousOpenCode === undefined) delete process.env.OPENCODE_CODEX_DATA_DIR
  else process.env.OPENCODE_CODEX_DATA_DIR = previousOpenCode
})

test("prefers the CyberVinci data override", () => {
  process.env.OPENCODE_CODEX_DATA_DIR = "legacy-pool"
  process.env.CYBERVINCI_CODEX_DATA_DIR = "cybervinci-pool"
  expect(dataRoot()).toBe("cybervinci-pool")
})

test("accepts the legacy OpenCode override for migration", () => {
  delete process.env.CYBERVINCI_CODEX_DATA_DIR
  process.env.OPENCODE_CODEX_DATA_DIR = "legacy-pool"
  expect(dataRoot()).toBe("legacy-pool")
})
