import { expect, test } from "bun:test"
import {
  configurePoolProvider,
  isPoolProvider,
  mirrorOpenAIModelsIntoPool,
  POOL_MODELS,
  POOL_PROVIDER_ID,
  poolModelsFromOpenAI,
  type OpenAIModelCatalogEntry,
} from "../src/provider"

function catalogModel(id: string, apiID = id): OpenAIModelCatalogEntry {
  return {
    id,
    api: { id: apiID },
    name: id.toUpperCase(),
    family: "gpt",
    status: "active",
    release_date: "2026-07-01",
    capabilities: {
      attachment: true,
      reasoning: true,
      temperature: false,
      toolcall: true,
      input: { text: true, image: true, pdf: true },
      output: { text: true },
    },
    limit: { context: 500_000, input: 372_000, output: 128_000 },
    options: { reasoningEffort: "high" },
    headers: { "x-model-mode": "test" },
    variants: { high: { reasoningEffort: "high" } },
  }
}

test("keeps concrete GPT-5.6 models as the startup fallback", () => {
  expect(Object.keys(POOL_MODELS).filter((model) => model.startsWith("gpt-5.6"))).toEqual([
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ])
})

test("derives every pool model from the resolved OpenAI catalog", () => {
  const source = {
    "gpt-5.6": catalogModel("gpt-5.6"),
    "gpt-5.6-fast": catalogModel("gpt-5.6-fast", "gpt-5.6"),
    "gpt-5.6-sol": catalogModel("gpt-5.6-sol"),
    "gpt-6.0-codex": catalogModel("gpt-6.0-codex"),
  }
  const original = structuredClone(source)

  const models = poolModelsFromOpenAI(source)

  expect(Object.keys(models)).toEqual(Object.keys(source))
  expect(models["gpt-5.6"].id).toBe("gpt-5.6-sol")
  expect(models["gpt-5.6-fast"].id).toBe("gpt-5.6-sol")
  expect(models["gpt-6.0-codex"].id).toBe("gpt-6.0-codex")
  expect(models["gpt-6.0-codex"]).toMatchObject({
    attachment: true,
    reasoning: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    options: { reasoningEffort: "high" },
    headers: { "x-model-mode": "test" },
  })
  expect(source).toEqual(original)
})

test("mirrors OpenAI models without replacing pool transport or explicit overrides", () => {
  const rotatingFetch = (() => undefined) as unknown as typeof fetch
  const config: any = { provider: { [POOL_PROVIDER_ID]: { models: {} } } }
  const pool = configurePoolProvider(config, { fetch: rotatingFetch, apiKey: "pool-key" })
  const source = {
    "gpt-5.6-sol": catalogModel("gpt-5.6-sol"),
    "gpt-6.0-codex": catalogModel("gpt-6.0-codex"),
  }

  mirrorOpenAIModelsIntoPool(pool, source, {
    "gpt-6.0-codex": { name: "Custom future model" },
    "local-override": { name: "Local override" },
  })

  expect(Object.keys(pool.models)).toEqual(["gpt-5.6-sol", "gpt-6.0-codex", "local-override"])
  expect(pool.models["gpt-6.0-codex"].name).toBe("Custom future model")
  expect(pool.options).toMatchObject({ apiKey: "pool-key", fetch: rotatingFetch })
})

test("adds the pool as a separate provider without changing OpenAI", () => {
  const openai = { name: "OpenAI", options: { apiKey: "official-key" }, models: { official: { name: "Official" } } }
  const config: any = { provider: { openai: structuredClone(openai) } }
  const rotatingFetch = (() => undefined) as unknown as typeof fetch

  const pool = configurePoolProvider(config, { name: "My Pool", fetch: rotatingFetch, apiKey: "pool-key" })

  expect(config.provider.openai).toEqual(openai)
  expect(pool.name).toBe("My Pool")
  expect(pool.npm).toBe("@ai-sdk/openai")
  expect(pool.options).toMatchObject({ apiKey: "pool-key", fetch: rotatingFetch })
  expect(Object.keys(pool.models)).toEqual(Object.keys(POOL_MODELS))
})

test("preserves explicit pool overrides and identifies only pool sessions", () => {
  const config: any = {
    provider: {
      [POOL_PROVIDER_ID]: {
        models: { "gpt-5.4": { name: "Custom GPT-5.4" } },
        options: { timeout: 1234 },
      },
    },
  }

  const pool = configurePoolProvider(config, { fetch, apiKey: "pool-key" })
  expect(pool.models["gpt-5.4"].name).toBe("Custom GPT-5.4")
  expect(pool.options.timeout).toBe(1234)
  expect(isPoolProvider(POOL_PROVIDER_ID)).toBe(true)
  expect(isPoolProvider("openai")).toBe(false)
})
