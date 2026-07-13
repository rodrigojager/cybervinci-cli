import { z } from "zod"

export const modelProfileSchema = z.object({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
  variant: z.string().min(1).optional(),
  advancedOptions: z.record(z.string(), z.unknown()).optional(),
})
export type ModelProfile = z.infer<typeof modelProfileSchema>

export const settingsSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  providerName: z.string().min(1).default("Codex Account Pool"),
  notifyActiveAccount: z.boolean().default(true),
  summarizer: z.object({
    enabled: z.boolean().default(false),
    primary: modelProfileSchema.optional(),
    fallback: modelProfileSchema.optional(),
    everyTurns: z.number().int().min(1).default(4),
    maxDeltaTokens: z.number().int().min(500).default(8000),
    maxSummaryTokens: z.number().int().min(250).default(3000),
    timeoutMs: z.number().int().min(1000).default(60000),
    finalSummaryThreshold: z.number().min(1).max(100).default(90),
    retainLastTurns: z.number().int().min(0).max(10).default(1),
    fallbackOn: z.array(z.enum([
      "provider_unavailable", "model_not_found", "auth", "rate_limit", "timeout", "server_error", "invalid_output",
    ])).default(["provider_unavailable", "model_not_found", "auth", "rate_limit", "timeout", "server_error", "invalid_output"]),
  }).default({ enabled: false, everyTurns: 4, maxDeltaTokens: 8000, maxSummaryTokens: 3000, timeoutMs: 60000, finalSummaryThreshold: 90, retainLastTurns: 1, fallbackOn: ["provider_unavailable", "model_not_found", "auth", "rate_limit", "timeout", "server_error", "invalid_output"] }),
  rotation: z.object({
    strategy: z.literal("sticky").default("sticky"),
    proactivePrimaryPercent: z.number().min(1).max(100).default(90),
    proactiveSecondaryPercent: z.number().min(1).max(100).default(95),
    rateLimitCooldownMs: z.number().int().min(1000).default(30000),
    authFailureCooldownMs: z.number().int().min(1000).default(300000),
    maxAttempts: z.number().int().min(1).default(10),
  }).default({ strategy: "sticky", proactivePrimaryPercent: 90, proactiveSecondaryPercent: 95, rateLimitCooldownMs: 30000, authFailureCooldownMs: 300000, maxAttempts: 10 }),
  quota: z.object({
    pollIntervalMs: z.number().int().min(5000).default(60000),
    staleAfterMs: z.number().int().min(5000).default(120000),
  }).default({ pollIntervalMs: 60000, staleAfterMs: 120000 }),
  scheduler: z.object({
    autoResumeGoals: z.boolean().default(true),
    resumeJitterMs: z.number().int().nonnegative().default(5000),
    resumeSpacingMs: z.number().int().nonnegative().default(15000),
    maxConcurrentResumesPerAccount: z.number().int().min(1).default(1),
    leaseMs: z.number().int().min(10000).default(60000),
  }).default({ autoResumeGoals: true, resumeJitterMs: 5000, resumeSpacingMs: 15000, maxConcurrentResumesPerAccount: 1, leaseMs: 60000 }),
})
export type Settings = z.infer<typeof settingsSchema>

export const defaultSettings = (): Settings => settingsSchema.parse({ version: 1, revision: 0 })

export const quotaWindowSchema = z.object({
  usedPercent: z.number(),
  windowSeconds: z.number().optional(),
  resetAt: z.number().optional(),
})
export type QuotaWindow = z.infer<typeof quotaWindowSchema>

export const accountQuotaSchema = z.object({
  planType: z.string().optional(),
  allowed: z.boolean().optional(),
  limitReached: z.boolean().optional(),
  reachedType: z.string().optional(),
  primary: quotaWindowSchema.optional(),
  secondary: quotaWindowSchema.optional(),
  codeReview: quotaWindowSchema.optional(),
  credits: z.object({
    hasCredits: z.boolean().optional(),
    unlimited: z.boolean().optional(),
    balance: z.union([z.string(), z.number()]).optional(),
  }).optional(),
  fetchedAt: z.number(),
  source: z.enum(["usage-endpoint", "headers", "response"]),
  error: z.string().optional(),
})
export type AccountQuota = z.infer<typeof accountQuotaSchema>

export const accountSchema = z.object({
  id: z.string(),
  label: z.string(),
  email: z.string().optional(),
  subjectID: z.string().optional(),
  workspaceAccountID: z.string().optional(),
  organizationID: z.string().optional(),
  planType: z.string().optional(),
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number().optional(),
  health: z.object({
    successes: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    cooldownUntil: z.number().optional(),
    lastStatus: z.number().optional(),
    lastErrorAt: z.number().optional(),
  }),
  quota: accountQuotaSchema.optional(),
})
export type Account = z.infer<typeof accountSchema>

export const accountsFileSchema = z.object({
  version: z.literal(2),
  initialized: z.boolean(),
  revision: z.number().int().nonnegative(),
  defaultAccountID: z.string().optional(),
  order: z.array(z.string()),
  accounts: z.array(accountSchema),
})
export type AccountsFile = z.infer<typeof accountsFileSchema>

export const bindingSchema = z.object({
  sessionID: z.string(),
  accountID: z.string(),
  epoch: z.number().int().nonnegative(),
  worktree: z.string().optional(),
  directory: z.string().optional(),
  agent: z.string().optional(),
  model: z.object({ providerID: z.string(), modelID: z.string(), variant: z.string().optional() }).optional(),
  pinnedByUser: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type SessionBinding = z.infer<typeof bindingSchema>

export const bindingsFileSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  bindings: z.record(z.string(), bindingSchema),
  reservations: z.array(z.object({ id: z.string(), accountID: z.string(), sessionID: z.string().optional(), instanceID: z.string(), expiresAt: z.number(), createdAt: z.number() })).default([]),
})

export const structuredSummarySchema = z.object({
  objective: z.string(),
  constraints: z.array(z.string()),
  decisions: z.array(z.string()),
  completed: z.array(z.string()),
  currentStep: z.string().optional(),
  nextSteps: z.array(z.string()),
  modifiedFiles: z.array(z.string()),
  tests: z.array(z.string()),
  blockers: z.array(z.string()),
  unresolvedQuestions: z.array(z.string()),
  importantReferences: z.array(z.string()),
})
export type StructuredSummary = z.infer<typeof structuredSummarySchema>

export type FailureCategory = Settings["summarizer"]["fallbackOn"][number]

export const ledgerSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  sessionID: z.string(),
  goal: z.object({ id: z.string().optional(), objective: z.string(), status: z.enum(["active", "paused", "complete", "unmet", "cleared"]), lastCheckpoint: z.string().optional(), updatedAt: z.number() }).optional(),
  todos: z.array(z.object({ content: z.string(), status: z.string(), priority: z.string().optional() })),
  completedSteps: z.array(z.string()),
  currentStep: z.string().optional(),
  pendingSteps: z.array(z.string()),
  decisions: z.array(z.object({ id: z.string(), category: z.string(), text: z.string(), replaceKey: z.string().optional(), createdAt: z.number() })),
  modifiedFiles: z.array(z.string()),
  verifications: z.array(z.object({ command: z.string(), result: z.string(), at: z.number() })),
  lastUserText: z.string().optional(),
  lastUserMessageID: z.string().optional(),
  lastAssistantMessageID: z.string().optional(),
  turnCount: z.number().int().nonnegative(),
  updatedAt: z.number(),
})
export type SessionLedger = z.infer<typeof ledgerSchema>

export const summaryFileSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  sessionID: z.string(),
  basedOnMessageID: z.string().optional(),
  generatedAt: z.number().optional(),
  generatedBy: z.object({ slot: z.enum(["primary", "fallback"]), providerID: z.string(), modelID: z.string(), variant: z.string().optional() }).optional(),
  settingsRevision: z.number().int().nonnegative().optional(),
  primaryFailure: z.object({ category: z.string(), message: z.string() }).optional(),
  summary: structuredSummarySchema.optional(),
  lastAttemptAt: z.number().optional(),
  lastError: z.string().optional(),
})
export type SummaryFile = z.infer<typeof summaryFileSchema>

export const epochSchema = z.object({
  sessionID: z.string(), epoch: z.number().int().nonnegative(), sourceAccountID: z.string().optional(), targetAccountID: z.string(),
  cutoffMessageID: z.string(), summaryRevision: z.number().int().nonnegative(), checkpointPath: z.string(),
  state: z.enum(["planned", "armed", "committed", "failed"]), reason: z.string(), createdAt: z.number(), committedAt: z.number().optional(),
})
export type ContextEpoch = z.infer<typeof epochSchema>

export const sessionStateSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(), sessionID: z.string(),
  epoch: epochSchema.optional(), status: z.enum(["active", "waiting_for_quota", "paused", "closed"]).default("active"), updatedAt: z.number(),
})
export type SessionState = z.infer<typeof sessionStateSchema>

export const resumeJobSchema = z.object({
  id: z.string(), sessionID: z.string(), goalID: z.string().optional(), goalActive: z.boolean(),
  state: z.enum(["waiting", "claimed", "resuming", "completed", "cancelled", "failed"]), resumeAt: z.number(), targetAccountID: z.string(), epoch: z.number().int().nonnegative(),
  agent: z.string(), model: z.object({ providerID: z.string(), modelID: z.string(), variant: z.string().optional() }),
  owner: z.object({ instanceID: z.string(), pid: z.number(), hostname: z.string(), leaseUntil: z.number() }).optional(),
  attempts: z.number().int().nonnegative(), createdAt: z.number(), updatedAt: z.number(), lastError: z.string().optional(),
})
export type ResumeJob = z.infer<typeof resumeJobSchema>

export const jobsFileSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), jobs: z.array(resumeJobSchema) })

export const accountActionSchema = z.object({
  id: z.string(), type: z.enum(["remove"]), accountID: z.string(), state: z.enum(["pending", "claimed", "completed", "failed"]),
  owner: z.string().optional(), leaseUntil: z.number().optional(), createdAt: z.number(), updatedAt: z.number(), result: z.string().optional(),
})
export type AccountAction = z.infer<typeof accountActionSchema>
export const accountActionsFileSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), actions: z.array(accountActionSchema) })
