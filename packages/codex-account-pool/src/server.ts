import { hostname, platform, release, arch } from "node:os"
import { readFile } from "node:fs/promises"
import type { Plugin, PluginModule, PluginOptions } from "@cybervinci-ai/plugin"
import { tool } from "@cybervinci-ai/plugin"
import { SettingsStore } from "./config"
import { AccountStore } from "./store"
import { BindingStore, earliestAccount, selectAccount } from "./bindings"
import { QuotaService, nearLimit, blockedUntil } from "./quota"
import { LedgerStore } from "./ledger"
import { HandoffStore, applyEpoch, handoffText } from "./handoff"
import { SummaryCoordinator } from "./summarizer"
import { ResumeScheduler } from "./scheduler"
import { browserAuthorization, cancelBrowserAuthorization, DEFAULT_CODEX_ENDPOINT, DEFAULT_ISSUER, deviceAuthorization, OAUTH_DUMMY_KEY, tokenIdentity, type OAuthTokens } from "./oauth"
import { createRotatingFetch } from "./rotating-fetch"
import type { Account, Settings } from "./domain"
import { AccountActionStore } from "./actions"
import {
  configurePoolProvider,
  isPoolProvider,
  mirrorOpenAIModelsIntoPool,
  POOL_PROVIDER_ID,
} from "./provider"

interface Options extends PluginOptions {
  issuer?: string
  codexApiEndpoint?: string
  storePath?: string
  providerName?: string
  quiet?: boolean
}

const RESUME_RE = /^<codex-account-pool-resume job="([^"]+)" epoch="(\d+)"\/>$/

const ServerPlugin: Plugin = async (ctx, rawOptions) => {
  const options = (rawOptions ?? {}) as Options
  const settingsStore = new SettingsStore()
  const accounts = new AccountStore(options.storePath)
  const bindings = new BindingStore()
  const quota = new QuotaService(accounts)
  const ledger = new LedgerStore()
  const handoff = new HandoffStore()
  const summaries = new SummaryCoordinator(ctx.client, ctx.directory, ledger, handoff)
  const scheduler = new ResumeScheduler(ctx.client, ctx.directory, () => settingsStore.get(true), undefined, accounts, bindings, quota, ledger)
  const lastNotified = new Map<string, string>()
  const actionStore = new AccountActionStore()
  let poolProviderConfig: ReturnType<typeof configurePoolProvider> | undefined
  let explicitPoolModelOverrides: Record<string, any> = {}
  let actionsRunning = false
  const actionTimer = setInterval(() => {
    if (actionsRunning) return
    actionsRunning = true
    void (async () => {
      const action = await actionStore.claim(scheduler.instanceID)
      if (!action) return
      try {
        const active = await bindings.activeReservations(action.accountID)
        if (active.length) { await actionStore.requeue(action.id, `Waiting for ${active.length} active request(s)`); return }
        const affected = await bindings.affected(action.accountID)
        const snapshot = await accounts.snapshot()
        const source = snapshot.accounts.find((item) => item.id === action.accountID)
        const replacement = selectAccount(snapshot.accounts.filter((item) => item.id !== action.accountID))
        for (const binding of affected) {
          if (replacement) {
            const data = await ledger.get(binding.sessionID)
            if (data.lastAssistantMessageID || data.lastUserMessageID) await createHandoff(binding.sessionID, source, replacement, "account_removed")
            await bindings.bind(binding.sessionID, replacement.id)
          } else await bindings.removeSession(binding.sessionID)
        }
        await accounts.remove(action.accountID)
        await actionStore.finish(action.id, "completed", `${affected.length} session(s) reassigned`)
      } catch (error) { await actionStore.finish(action.id, "failed", String(error).slice(0, 500)) }
    })().finally(() => { actionsRunning = false })
  }, 500)
  actionTimer.unref?.()
  scheduler.start()

  async function settings(): Promise<Settings> {
    const current = await settingsStore.get()
    if (options.providerName && current.revision === 0) current.providerName = options.providerName
    return current
  }

  async function saveTokens(tokens: OAuthTokens) {
    const identity = tokenIdentity(tokens)
    const account = await accounts.add({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000, workspaceAccountID: identity.accountId, email: identity.email, subjectID: identity.subjectID, organizationID: identity.organizationID })
    void quota.refresh(account, true).catch(() => {})
    return { type: "success" as const, refresh: account.refreshToken, access: account.accessToken, expires: account.expiresAt, accountId: account.workspaceAccountID }
  }

  async function toast(title: string, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
    if (options.quiet) return
    await ctx.client.tui.showToast({ body: { title, message, variant, duration: 5000 } }).catch(() => {})
  }

  async function createHandoff(sessionID: string, source: Account | undefined, target: Account, reason: string) {
    const data = await ledger.get(sessionID)
    const summary = await handoff.summary(sessionID)
    const cutoff = data.lastAssistantMessageID ?? data.lastUserMessageID
    if (!cutoff) return
    const result = await handoff.checkpoint({ sessionID, source, target, ledger: data, summary: summary.summary, cutoffMessageID: cutoff, reason, quota: source?.quota })
    await bindings.bind(sessionID, target.id, { epoch: result.epoch.epoch })
    return result
  }

  async function proactive(sessionID: string) {
    const cfg = await settings()
    const binding = await bindings.get(sessionID)
    if (!binding) return
    const snapshot = await accounts.snapshot()
    const source = snapshot.accounts.find((item) => item.id === binding.accountID)
    if (!source?.enabled) return
    await quota.refresh(source).catch(() => undefined)
    const fresh = (await accounts.snapshot()).accounts.find((item) => item.id === source.id) ?? source
    if (nearLimit(fresh, cfg.summarizer.finalSummaryThreshold, cfg.summarizer.finalSummaryThreshold)) await summaries.refresh(sessionID, cfg).catch(() => {})
    if (!nearLimit(fresh, cfg.rotation.proactivePrimaryPercent, cfg.rotation.proactiveSecondaryPercent)) return
    const target = selectAccount((await accounts.snapshot()).accounts.filter((item) => item.id !== source.id))
    if (!target) return
    if (nearLimit(target, cfg.rotation.proactivePrimaryPercent, cfg.rotation.proactiveSecondaryPercent)) return
    if (!nearLimit(fresh, cfg.summarizer.finalSummaryThreshold, cfg.summarizer.finalSummaryThreshold)) await summaries.refresh(sessionID, cfg).catch(() => {})
    const result = await createHandoff(sessionID, fresh, target, "proactive_quota")
    if (result) await toast("Codex handoff preparado", `${fresh.label} -> ${target.label}`, "warning")
  }

  async function waitForQuota(sessionID: string | undefined, target: Account | undefined, resumeAt: number | undefined) {
    if (!sessionID || !target || !resumeAt) return
    const binding = await bindings.get(sessionID)
    const data = await ledger.get(sessionID)
    if (!binding?.model || !binding.agent || !data.goal || data.goal.status !== "active") return
    const result = await createHandoff(sessionID, (await accounts.snapshot()).accounts.find((item) => item.id === binding.accountID), target, "all_accounts_exhausted")
    const epoch = result?.epoch.epoch ?? binding.epoch
    await scheduler.wait({ sessionID, goalID: data.goal.id, agent: binding.agent, model: binding.model, targetAccountID: target.id, resumeAt, epoch })
    await toast("Todas as contas Codex esgotadas", `Goal suspenso. ${target.label} sera revalidada em ${new Date(resumeAt).toLocaleString()}.`, "warning")
  }

  async function emergencyBody(input: { sessionID?: string; from: Account; to: Account; requestInput: RequestInfo | URL; init?: RequestInit }) {
    if (!input.sessionID || typeof input.init?.body !== "string") return
    const result = await createHandoff(input.sessionID, input.from, input.to, "emergency_failover")
    if (!result) return
    try {
      const body = JSON.parse(input.init.body)
      if (!Array.isArray(body.input)) return
      let index = -1
      for (let i = body.input.length - 1; i >= 0; i--) if (body.input[i]?.role === "user") { index = i; break }
      const currentTurn = index >= 0 ? body.input.slice(index) : body.input.slice(-8)
      body.input = [{ type: "message", role: "developer", content: [{ type: "input_text", text: handoffText(result.checkpoint) }] }, ...currentTurn]
      return { init: { ...input.init, body: JSON.stringify(body) } }
    } catch { return }
  }

  const rotatingFetch = createRotatingFetch(accounts, {
    settings,
    bindings,
    quota,
    issuer: options.issuer ?? DEFAULT_ISSUER,
    codexApiEndpoint: options.codexApiEndpoint ?? DEFAULT_CODEX_ENDPOINT,
    async onSelected(sessionID, account) {
      if (sessionID) {
        const state = await handoff.state(sessionID)
        if (state.epoch?.targetAccountID === account.id && state.epoch.state === "armed") await handoff.commitEpoch(sessionID, state.epoch.epoch)
        if (lastNotified.get(sessionID) !== account.id && (await settings()).notifyActiveAccount) {
          lastNotified.set(sessionID, account.id)
          await toast("Conta Codex ativa", account.email ? `${account.label} (${account.email})` : account.label)
        }
      }
    },
    async onFailover(sessionID, from, to, status) { await toast("Codex account failover", `${from.label} -> ${to?.label ?? "nenhuma"} (${status || "erro"})`, "warning") },
    onAllExhausted: waitForQuota,
    prepareFailover: emergencyBody,
  })

  return {
    async dispose() { scheduler.stop(); clearInterval(actionTimer); cancelBrowserAuthorization("Codex account pool plugin stopped") },
    async config(config) {
      const cfg = await settings()
      const existingPool = config.provider?.[POOL_PROVIDER_ID] as { models?: Record<string, any> } | undefined
      explicitPoolModelOverrides = { ...(existingPool?.models ?? {}) }
      poolProviderConfig = configurePoolProvider(config, {
        name: cfg.providerName,
        fetch: rotatingFetch,
        apiKey: OAUTH_DUMMY_KEY,
      })
      config.agent ??= {}
      config.agent["handoff-summarizer"] = {
        description: "Maintains a structured handoff summary in an isolated child session.", mode: "subagent", hidden: true,
        permission: { edit: "deny", bash: "deny", task: "deny", webfetch: "deny", websearch: "deny" },
      } as any
    },
    provider: {
      id: "openai",
      async models(provider) {
        if (poolProviderConfig) {
          mirrorOpenAIModelsIntoPool(poolProviderConfig, provider.models, explicitPoolModelOverrides)
        }
        return provider.models
      },
    },
    auth: {
      provider: POOL_PROVIDER_ID,
      async loader(getAuth) {
        const auth = await getAuth()
        const initialized = await accounts.initialize()
        if (!initialized && auth.type === "oauth") await accounts.add({ accessToken: auth.access, refreshToken: auth.refresh, expiresAt: auth.expires, workspaceAccountID: auth.accountId })
        if (auth.type !== "oauth") return {}
        return { apiKey: OAUTH_DUMMY_KEY, fetch: rotatingFetch }
      },
      methods: [
        { label: "ChatGPT Plus/Pro - adicionar conta (browser)", type: "oauth", async authorize() { const auth = await browserAuthorization(options.issuer ?? DEFAULT_ISSUER); return { url: auth.url, instructions: "Conclua o login no browser.", method: "auto" as const, callback: async () => saveTokens(await auth.callback) } } },
        { label: "ChatGPT Plus/Pro - adicionar conta (headless)", type: "oauth", async authorize() { const auth = await deviceAuthorization(options.issuer ?? DEFAULT_ISSUER); return { url: auth.url, instructions: `Digite o codigo: ${auth.code}`, method: "auto" as const, callback: async () => saveTokens(await auth.callback()) } } },
      ],
    },
    tool: {
      codex_account_current: tool({ description: "Show the Codex account bound to the current session", args: {}, async execute(_, context) { const binding = await bindings.get(context.sessionID); const account = (await accounts.snapshot()).accounts.find((item) => item.id === binding?.accountID); return account ? JSON.stringify({ id: account.id, label: account.label, email: account.email, workspace: account.workspaceAccountID, quota: account.quota }, null, 2) : "Nenhuma conta vinculada." } }),
      codex_accounts_list: tool({ description: "List Codex accounts without credentials", args: {}, async execute(_, context) { const binding = await bindings.get(context.sessionID); const snapshot = await accounts.snapshot(); return JSON.stringify(snapshot.accounts.map((item) => ({ id: item.id, label: item.label, email: item.email, workspace: item.workspaceAccountID, plan: item.planType, enabled: item.enabled, active: item.id === binding?.accountID, default: item.id === snapshot.defaultAccountID, quota: item.quota, health: item.health })), null, 2) } }),
      codex_accounts_set_active: tool({ description: "Bind a Codex account to the current session", args: { id: tool.schema.string() }, async execute({ id }, context) { const account = (await accounts.snapshot()).accounts.find((item) => item.id === id && item.enabled); if (!account) return "Conta nao encontrada ou desabilitada."; const previous = await bindings.get(context.sessionID); const source = (await accounts.snapshot()).accounts.find((item) => item.id === previous?.accountID); await createHandoff(context.sessionID, source, account, "manual_switch"); await bindings.bind(context.sessionID, id, { pinnedByUser: true }); return "Conta vinculada a esta sessao." } }),
      codex_accounts_set_default: tool({ description: "Set the default Codex account for new sessions", args: { id: tool.schema.string() }, async execute({ id }) { return await accounts.setDefault(id) ? "Conta default atualizada." : "Conta nao encontrada." } }),
      codex_accounts_enable: tool({ description: "Enable or disable a Codex account", args: { id: tool.schema.string(), enabled: tool.schema.boolean() }, async execute({ id, enabled }) { return await accounts.setEnabled(id, enabled) ? "Conta atualizada." : "Conta nao encontrada." } }),
      codex_accounts_rename: tool({ description: "Rename a Codex account", args: { id: tool.schema.string(), label: tool.schema.string() }, async execute({ id, label }) { return await accounts.renameAccount(id, label) ? "Conta renomeada." : "Conta nao encontrada." } }),
      codex_accounts_remove: tool({ description: "Remove a Codex account safely", args: { id: tool.schema.string() }, async execute({ id }, context) { await context.ask({ permission: "codex_accounts_remove", patterns: [id], always: [], metadata: {} }); const account = (await accounts.snapshot()).accounts.find((item) => item.id === id); if (!account) return "Conta nao encontrada."; await accounts.setEnabled(id, false); await actionStore.enqueueRemove(id); return "Conta desabilitada; remocao segura enfileirada apos requests ativos e handoffs." } }),
      codex_quota_refresh: tool({ description: "Refresh Codex quota for all accounts", args: {}, async execute() { const result = await quota.refreshAll(true); return `Quota atualizada: ${result.filter((item) => item.status === "fulfilled").length} sucesso(s), ${result.filter((item) => item.status === "rejected").length} falha(s).` } }),
      codex_handoff_note: tool({ description: "Persist an important decision, constraint, blocker, or reference for future handoffs", args: { category: tool.schema.enum(["decision", "constraint", "blocker", "reference"]), text: tool.schema.string(), replaceKey: tool.schema.string().optional() }, async execute(args, context) { await ledger.note(context.sessionID, args.category, args.text, args.replaceKey); return "Nota de handoff salva." } }),
      codex_handoff_status: tool({ description: "Show handoff, summary and waiting state for this session", args: {}, async execute(_, context) { return JSON.stringify({ binding: await bindings.get(context.sessionID), state: await handoff.state(context.sessionID), summary: await handoff.summary(context.sessionID) }, null, 2) } }),
      codex_handoff_now: tool({ description: "Create a handoff to the best other Codex account now", args: {}, async execute(_, context) { const binding = await bindings.get(context.sessionID); const snapshot = await accounts.snapshot(); const source = snapshot.accounts.find((item) => item.id === binding?.accountID); const target = selectAccount(snapshot.accounts.filter((item) => item.id !== source?.id)); if (!target) return "Nenhuma conta alternativa disponivel."; await summaries.refresh(context.sessionID, await settings()).catch(() => {}); await createHandoff(context.sessionID, source, target, "manual_handoff"); return `Handoff preparado para ${target.label}.` } }),
    },
    async event({ event }: any) {
      const properties = event.properties ?? {}
      const sid = properties.sessionID ?? properties.info?.sessionID
      if (!sid || summaries.isInternal(sid)) return
      const binding = await bindings.get(sid)
      if (!isPoolProvider(binding?.model?.providerID)) return
      if (event.type === "session.idle") { const cfg = await settings(); summaries.schedule(sid, cfg); void proactive(sid).catch(() => {}) }
      if (event.type === "session.deleted") { await scheduler.cancel(sid); await bindings.removeSession(sid) }
      if (event.type === "file.edited" || event.type === "file.watcher.updated") { const file = properties.file ?? properties.path; if (typeof file === "string") await ledger.file(sid, file) }
      if (event.type === "todo.updated" && Array.isArray(properties.todos)) await ledger.setTodos(sid, properties.todos)
      if (event.type === "message.updated" && properties.info?.role === "assistant" && properties.info?.finish) await ledger.assistant(sid, properties.info.id)
    },
    async "chat.message"(input, output) {
      if (!isPoolProvider(input.model?.providerID)) {
        if (await bindings.get(input.sessionID)) {
          await scheduler.cancel(input.sessionID)
          await bindings.removeSession(input.sessionID)
        }
        return
      }
      const textParts = output.parts.filter((part: any) => part.type === "text") as any[]
      const text = textParts.map((part) => part.text).join("\n")
      const resume = text.match(RESUME_RE)
      if (resume) { for (const part of textParts) { part.synthetic = true; part.text = "Continue the active goal from the handoff state after the Codex quota reset." } }
      else await ledger.userMessage(input.sessionID, input.messageID, text)
      if (input.model) {
        const existing = await bindings.get(input.sessionID)
        const snapshot = await accounts.snapshot()
        const selected = existing?.accountID || selectAccount(snapshot.accounts, snapshot.defaultAccountID)?.id
        if (selected) await bindings.bind(input.sessionID, selected, { agent: input.agent, model: { providerID: input.model.providerID, modelID: input.model.modelID, variant: input.variant } }).catch(() => {})
      }
    },
    async "tool.execute.before"(input, output) {
      if (!isPoolProvider((await bindings.get(input.sessionID))?.model?.providerID)) return
      if (["create_goal", "set_goal"].includes(input.tool)) await ledger.setGoal(input.sessionID, { objective: output.args.objective, status: "active" })
      if (input.tool === "update_goal_objective") await ledger.setGoal(input.sessionID, { objective: output.args.objective })
      if (input.tool === "update_goal_status") await ledger.setGoal(input.sessionID, { status: output.args.status })
      if (input.tool === "update_goal") await ledger.setGoal(input.sessionID, { status: output.args.status, lastCheckpoint: output.args.evidence ?? output.args.blocker })
      if (input.tool === "update_goal" && ["complete", "unmet"].includes(output.args.status)) await scheduler.cancel(input.sessionID)
      if (input.tool === "clear_goal") { await ledger.setGoal(input.sessionID, { status: "cleared" }); await scheduler.cancel(input.sessionID) }
      if (input.tool === "todowrite" && Array.isArray(output.args.todos)) await ledger.setTodos(input.sessionID, output.args.todos)
    },
    async "tool.execute.after"(input, output) {
      if (!isPoolProvider((await bindings.get(input.sessionID))?.model?.providerID)) return
      if (input.tool === "bash") await ledger.verification(input.sessionID, String(input.args.command ?? ""), output.output.slice(-1000))
    },
    async "experimental.chat.messages.transform"(_, output) {
      const sid = output.messages.find((item: any) => item.info?.sessionID)?.info?.sessionID
      if (!sid) return
      const state = await handoff.state(sid)
      if (!state.epoch || !["armed", "committed"].includes(state.epoch.state)) return
      const checkpoint = JSON.parse(await readFile(state.epoch.checkpointPath, "utf8"))
      output.messages.splice(0, output.messages.length, ...applyEpoch(output.messages, state.epoch.cutoffMessageID, handoffText(checkpoint), (await settings()).summarizer.retainLastTurns))
    },
    async "chat.headers"(input, output) {
      if (!isPoolProvider(input.model.providerID)) return
      output.headers.originator = "opencode"
      output.headers["User-Agent"] = `opencode (${platform()} ${release()}; ${arch()}; ${hostname()})`
      output.headers["session-id"] = input.sessionID
      let binding = await bindings.get(input.sessionID)
      if (!binding) {
        const snapshot = await accounts.snapshot()
        const selected = selectAccount(snapshot.accounts, snapshot.defaultAccountID)
        if (selected) binding = await bindings.bind(input.sessionID, selected.id, { agent: input.agent, model: { providerID: input.model.providerID, modelID: input.model.id } })
      }
      if (binding) await bindings.bind(input.sessionID, binding.accountID, { agent: input.agent, model: { providerID: input.model.providerID, modelID: input.model.id, variant: binding.model?.variant } })
    },
    async "chat.params"(input, output) {
      if (isPoolProvider(input.model.providerID)) output.maxOutputTokens = undefined
      if (summaries.isInternal(input.sessionID)) {
        const profile = summaries.profile(input.sessionID)
        if (profile?.advancedOptions) Object.assign(output.options, profile.advancedOptions)
      }
    },
  }
}

const module: PluginModule & { id: string } = { id: "cybervinci-codex-account-pool", server: ServerPlugin }
export default module
export { ServerPlugin }
