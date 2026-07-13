import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Catalog } from "@cybervinci-ai/core/catalog"
import { PluginV2 } from "@cybervinci-ai/core/plugin"
import { PluginHost } from "@cybervinci-ai/core/plugin/host"
import { ProviderPlugins } from "@cybervinci-ai/core/plugin/provider"
import { ZenmuxPlugin } from "@cybervinci-ai/core/plugin/provider/zenmux"
import { ProviderV2 } from "@cybervinci-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* ZenmuxPlugin.effect(host)
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

describe("ZenmuxPlugin", () => {
  it.effect("is registered so CYBERVINCI integration headers can be applied", () =>
    Effect.sync(() => expect(ProviderPlugins.map((item) => item.id)).toContain(PluginV2.ID.make("zenmux"))),
  )

  it.effect("applies the CYBERVINCI Zenmux headers", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(ProviderV2.ID.make("zenmux"), (provider) => {
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://zenmux.ai/api/v1",
          }
        })
      })
      yield* addPlugin()
      const result = required(yield* catalog.provider.get(ProviderV2.ID.make("zenmux")))
      expect(Object.keys(result.request.headers).sort()).toEqual(["X-Title"])
    }),
  )

  it.effect("merges CYBERVINCI Zenmux headers with existing headers", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(ProviderV2.ID.make("zenmux"), (provider) => {
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://zenmux.ai/api/v1",
          }
          provider.request.headers.Existing = "value"
        })
      })
      yield* addPlugin()

      expect(required(yield* catalog.provider.get(ProviderV2.ID.make("zenmux"))).request.headers).toEqual({
        Existing: "value",
        "X-Title": "cybervinci",
      })
    }),
  )

  it.effect("lets configured Zenmux legacy headers override defaults", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(ProviderV2.ID.make("zenmux"), (provider) => {
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://zenmux.ai/api/v1",
          }
          provider.request.headers = { "HTTP-Referer": "https://example.com/", "X-Title": "custom-title" }
        })
      })
      yield* addPlugin()

      expect(required(yield* catalog.provider.get(ProviderV2.ID.make("zenmux"))).request.headers).toEqual({
        "HTTP-Referer": "https://example.com/",
        "X-Title": "custom-title",
      })
    }),
  )

  it.effect("guards CYBERVINCI Zenmux headers to the exact zenmux provider id", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(ProviderV2.ID.openrouter, (provider) => {
          provider.request.headers = { "HTTP-Referer": "https://example.com/", "X-Title": "custom-title" }
        })
      })
      yield* addPlugin()

      expect(required(yield* catalog.provider.get(ProviderV2.ID.openrouter)).request.headers).toEqual({
        "HTTP-Referer": "https://example.com/",
        "X-Title": "custom-title",
      })
    }),
  )
})
