import { expect, test } from "bun:test"
import { createBuiltinPlugins } from "../../src/feature-plugins/builtins"

test("loads the Codex account pool as a default TUI plugin", () => {
  expect(createBuiltinPlugins({ experimentalEventSystem: false }).map((plugin) => plugin.id)).toContain(
    "cybervinci-codex-account-pool",
  )
})
