export const POOL_PROVIDER_ID = "openai-codex-pool"
export const POOL_PROVIDER_NAME = "Codex Account Pool"

const zeroCost = { input: 0, output: 0, cache_read: 0, cache_write: 0 }

const MODEL_MODALITIES = ["text", "audio", "image", "video", "pdf"] as const

type ModelModality = (typeof MODEL_MODALITIES)[number]

export interface OpenAIModelCatalogEntry {
  id?: string
  name?: string
  family?: string
  api?: { id?: string }
  status?: string
  release_date?: string
  capabilities?: {
    attachment?: boolean
    reasoning?: boolean
    temperature?: boolean
    toolcall?: boolean
    input?: Partial<Record<ModelModality, boolean>>
    output?: Partial<Record<ModelModality, boolean>>
    interleaved?: boolean | { field: string }
  }
  limit?: { context?: number; input?: number; output?: number }
  options?: Record<string, unknown>
  headers?: Record<string, string>
  variants?: Record<string, unknown>
}

export type OpenAIModelCatalog = Record<string, OpenAIModelCatalogEntry>

interface ConfiguredPoolProvider {
  models?: Record<string, any>
}

export const POOL_MODELS = {
  "gpt-5.6-sol": {
    name: "GPT-5.6 Sol (Pooler)",
    family: "gpt",
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 500_000, input: 372_000, output: 128_000 },
    cost: zeroCost,
  },
  "gpt-5.6-terra": {
    name: "GPT-5.6 Terra (Pooler)",
    family: "gpt",
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 500_000, input: 372_000, output: 128_000 },
    cost: zeroCost,
  },
  "gpt-5.6-luna": {
    name: "GPT-5.6 Luna (Pooler)",
    family: "gpt",
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 500_000, input: 372_000, output: 128_000 },
    cost: zeroCost,
  },
  "gpt-5.5": {
    name: "GPT-5.5 (Pooler)",
    family: "gpt",
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 400_000, input: 272_000, output: 128_000 },
    cost: zeroCost,
  },
  "gpt-5.3-codex-spark": {
    name: "GPT-5.3 Codex Spark (Pooler)",
    family: "gpt-codex-spark",
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 128_000, input: 100_000, output: 32_000 },
    cost: zeroCost,
  },
  "gpt-5.4": {
    name: "GPT-5.4 (Pooler)",
    family: "gpt",
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 1_050_000, input: 922_000, output: 128_000 },
    cost: zeroCost,
  },
  "gpt-5.4-mini": {
    name: "GPT-5.4 mini (Pooler)",
    family: "gpt-mini",
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 400_000, input: 272_000, output: 128_000 },
    cost: zeroCost,
  },
} as const

function enabledModalities(capabilities: Partial<Record<ModelModality, boolean>> | undefined) {
  return MODEL_MODALITIES.filter((modality) => capabilities?.[modality] === true)
}

function resolvePoolApiModelID(
  modelID: string,
  model: OpenAIModelCatalogEntry,
  sourceModels: OpenAIModelCatalog,
) {
  const apiModelID = model.api?.id ?? model.id ?? modelID
  const concreteSolID = `${apiModelID}-sol`
  return sourceModels[concreteSolID] ? concreteSolID : apiModelID
}

/**
 * Convert the already-resolved OpenAI catalog into provider config entries for
 * the pool. The public model IDs stay identical; only the transport model ID is
 * normalized to a concrete Sol model when the catalog exposes one.
 */
export function poolModelsFromOpenAI(sourceModels: OpenAIModelCatalog) {
  return Object.fromEntries(
    Object.entries(sourceModels).map(([modelID, model]) => [
      modelID,
      {
        id: resolvePoolApiModelID(modelID, model, sourceModels),
        name: model.name ?? modelID,
        family: model.family ?? "",
        attachment: model.capabilities?.attachment ?? false,
        reasoning: model.capabilities?.reasoning ?? false,
        temperature: model.capabilities?.temperature ?? false,
        tool_call: model.capabilities?.toolcall ?? true,
        modalities: {
          input: enabledModalities(model.capabilities?.input),
          output: enabledModalities(model.capabilities?.output),
        },
        limit: {
          context: model.limit?.context ?? 0,
          ...(model.limit?.input === undefined ? {} : { input: model.limit.input }),
          output: model.limit?.output ?? 0,
        },
        cost: zeroCost,
        ...(model.status ? { status: model.status } : {}),
        ...(model.release_date ? { release_date: model.release_date } : {}),
        ...(model.capabilities?.interleaved === undefined
          ? {}
          : { interleaved: model.capabilities.interleaved }),
        ...(model.options ? { options: { ...model.options } } : {}),
        ...(model.headers ? { headers: { ...model.headers } } : {}),
        ...(model.variants ? { variants: { ...model.variants } } : {}),
      },
    ]),
  )
}

export function mirrorOpenAIModelsIntoPool(
  provider: ConfiguredPoolProvider,
  sourceModels: OpenAIModelCatalog,
  explicitOverrides: Record<string, any> = {},
) {
  provider.models = {
    ...poolModelsFromOpenAI(sourceModels),
    ...explicitOverrides,
  }
  return provider.models
}

interface PoolProviderConfig {
  provider?: Record<string, any>
}

type PoolFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function configurePoolProvider(
  config: PoolProviderConfig,
  input: { name?: string; fetch: PoolFetch; apiKey: string },
) {
  config.provider ??= {}
  const existing = config.provider[POOL_PROVIDER_ID] ?? {}
  config.provider[POOL_PROVIDER_ID] = {
    ...existing,
    name: input.name || existing.name || POOL_PROVIDER_NAME,
    npm: "@ai-sdk/openai",
    options: {
      ...(existing.options ?? {}),
      apiKey: input.apiKey,
      fetch: input.fetch,
    },
    models: {
      ...POOL_MODELS,
      ...(existing.models ?? {}),
    },
  }
  return config.provider[POOL_PROVIDER_ID]
}

export function isPoolProvider(providerID: string | undefined) {
  return providerID === POOL_PROVIDER_ID
}
