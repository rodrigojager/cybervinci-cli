import { expect, test } from "bun:test"
import { ServerPlugin } from "@cybervinci-ai/codex-account-pool/server"
import { internalPlugins } from "../../src/plugin"

test("loads the Codex account pool as a default server plugin", () => {
  expect(internalPlugins({ experimentalWebSockets: false })).toContain(ServerPlugin)
})
