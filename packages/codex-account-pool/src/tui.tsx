/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiDialogSelectOption } from "@cybervinci-ai/plugin/tui"
import { spawn } from "node:child_process"
import { SettingsStore } from "./config"
import { AccountStore } from "./store"
import { BindingStore } from "./bindings"
import { QuotaService, blockedUntil } from "./quota"
import { AccountActionStore } from "./actions"
import type { ModelProfile, Settings } from "./domain"
import { JobStore } from "./scheduler"
import { HandoffStore } from "./handoff"
import { POOL_PROVIDER_ID } from "./provider"

function openExternal(url: string) {
  const command = process.platform === "win32" ? ["rundll32.exe", "url.dll,FileProtocolHandler", url] : process.platform === "darwin" ? ["open", url] : ["xdg-open", url]
  const child = spawn(command[0], command.slice(1), { detached: true, stdio: "ignore" })
  child.unref()
}

const tui: TuiPlugin = async (api) => {
  const settingsStore = new SettingsStore()
  const accounts = new AccountStore()
  const bindings = new BindingStore()
  const quota = new QuotaService(accounts)
  const actions = new AccountActionStore()
  const jobs = new JobStore()
  const handoff = new HandoffStore()
  const DialogSelect = api.ui.DialogSelect
  const DialogPrompt = api.ui.DialogPrompt
  const DialogConfirm = api.ui.DialogConfirm
  const DialogAlert = api.ui.DialogAlert
  const dialog = api.ui.dialog
  const currentSession = (): string | undefined => {
    const route = api.route.current
    return route.name === "session" && typeof route.params?.sessionID === "string" ? route.params.sessionID : undefined
  }

  function select<Value>(title: string, options: TuiDialogSelectOption<Value>[], onSelect: (value: Value) => void, current?: Value) {
    dialog.replace(() => <DialogSelect title={title} options={options} current={current} onSelect={(option) => onSelect(option.value)} />)
  }

  async function providers() {
    if (api.state.provider.length) return [...api.state.provider]
    const response = await api.client.provider.list({ directory: api.state.path.directory })
    const data: any = response.data
    return data?.all ?? (Array.isArray(data) ? data : [])
  }

  async function pickProfile(title: string, initial: ModelProfile | undefined, done: (profile: ModelProfile) => void) {
    const list: any[] = await providers()
    select(`${title}: provider`, list.map((provider) => ({ title: provider.name, description: provider.id, value: provider })), (provider: any) => {
      const models = Object.values(provider.models ?? {}) as any[]
      select(`${title}: model`, models.map((model) => ({ title: model.name, description: model.id, value: model })), (model: any) => {
        const variants = [undefined, ...Object.keys(model.variants ?? {})]
        select(`${title}: reasoning / variant`, variants.map((variant) => ({ title: variant ?? "Default", value: variant })), (variant) => done({ providerID: provider.id, modelID: model.id, ...(variant ? { variant } : {}) }), initial?.variant)
      }, initial?.modelID as any)
    }, initial?.providerID as any)
  }

  async function testProfile(profile: ModelProfile) {
    api.ui.toast({ title: "Handoff summarizer", message: "Testing model...", variant: "info" })
    let id: string | undefined
    try {
      const created = await api.client.session.create({ directory: api.state.path.directory, title: "[internal] summarizer test" } as any)
      id = created.data!.id
      const result = await api.client.session.prompt({ sessionID: id, directory: api.state.path.directory, model: { providerID: profile.providerID, modelID: profile.modelID }, variant: profile.variant, tools: { bash: false, read: false, edit: false, task: false }, parts: [{ type: "text", text: "Return exactly this JSON and nothing else: {\"ok\":true}" }] } as any)
      const text = (result.data?.parts ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("")
      if (!text.includes('"ok"')) throw new Error("Unexpected response")
      api.ui.toast({ title: "Handoff summarizer", message: "Model test passed.", variant: "success" })
    } catch (error) { api.ui.toast({ title: "Handoff summarizer", message: String(error), variant: "error" }) }
    finally { if (id) await api.client.session.delete({ sessionID: id, directory: api.state.path.directory } as any).catch(() => {}) }
  }

  async function settingsDialog() {
    const current = await settingsStore.get(true)
    const draft = structuredClone(current)
    pickProfile("Primary summarizer", draft.summarizer.primary, (primary) => {
      draft.summarizer.primary = primary
      select("Configure optional fallback?", [
        { title: "No fallback", value: false },
        { title: "Configure fallback", value: true },
      ], (withFallback) => {
        const finish = () => configureSummaryNumbers(draft, () => reviewSettings(draft))
        if (!withFallback) { draft.summarizer.fallback = undefined; finish(); return }
        pickProfile("Fallback summarizer", draft.summarizer.fallback, (fallback) => { draft.summarizer.fallback = fallback; finish() })
      })
    })
  }

  function configureSummaryNumbers(draft: Settings, done: () => void) {
    const fields: Array<{ title: string; key: "everyTurns" | "maxDeltaTokens" | "maxSummaryTokens" | "timeoutMs" | "finalSummaryThreshold"; min: number }> = [
      { title: "Update every N completed turns", key: "everyTurns", min: 1 },
      { title: "Maximum new input tokens per summary", key: "maxDeltaTokens", min: 500 },
      { title: "Maximum final summary tokens", key: "maxSummaryTokens", min: 250 },
      { title: "Summarizer timeout in milliseconds", key: "timeoutMs", min: 1000 },
      { title: "Final summary quota threshold (%)", key: "finalSummaryThreshold", min: 1 },
    ]
    const next = (index: number) => {
      const field = fields[index]
      if (!field) { done(); return }
      dialog.replace(() => <DialogPrompt title={field.title} value={String(draft.summarizer[field.key])} onConfirm={(raw) => {
        const value = Number(raw)
        if (!Number.isFinite(value) || value < field.min) { api.ui.toast({ message: `Value must be >= ${field.min}`, variant: "error" }); next(index); return }
        ;(draft.summarizer[field.key] as number) = value
        next(index + 1)
      }} onCancel={() => dialog.clear()} />)
    }
    next(0)
  }

  function reviewSettings(draft: Settings) {
    const primary = draft.summarizer.primary!
    const fallback = draft.summarizer.fallback
    select("Review handoff summarizer", [
      { title: "Test primary", description: `${primary.providerID}/${primary.modelID}${primary.variant ? ` (${primary.variant})` : ""}`, value: "test-primary" },
      { title: "Test fallback", description: fallback ? `${fallback.providerID}/${fallback.modelID}${fallback.variant ? ` (${fallback.variant})` : ""}` : "Not configured", value: "test-fallback", disabled: !fallback },
      { title: "Primary advanced options", description: "Optional JSON", value: "advanced-primary" },
      { title: "Fallback advanced options", description: "Optional JSON", value: "advanced-fallback", disabled: !fallback },
      { title: "Remove fallback", value: "remove-fallback", disabled: !fallback },
      { title: "Save globally", description: "Applies to every CyberVinci window", value: "save" },
      { title: "Cancel", value: "cancel" },
    ], async (action) => {
      if (action === "test-primary") { await testProfile(primary); reviewSettings(draft) }
      if (action === "test-fallback" && fallback) { await testProfile(fallback); reviewSettings(draft) }
      if (action === "remove-fallback") { draft.summarizer.fallback = undefined; reviewSettings(draft) }
      if (action === "advanced-primary") return editAdvanced(primary, () => reviewSettings(draft))
      if (action === "advanced-fallback" && fallback) return editAdvanced(fallback, () => reviewSettings(draft))
      if (action === "save") { draft.summarizer.enabled = true; await settingsStore.save(draft); api.ui.toast({ title: "Handoff summarizer", message: "Global settings saved for all CyberVinci windows.", variant: "success" }); dialog.clear() }
      if (action === "cancel") dialog.clear()
    })
  }

  function editAdvanced(profile: ModelProfile, done: () => void) {
    dialog.replace(() => <DialogPrompt title="Advanced provider options (JSON)" value={JSON.stringify(profile.advancedOptions ?? {})} onConfirm={(raw: string) => {
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Expected a JSON object")
        profile.advancedOptions = Object.keys(parsed).length ? parsed : undefined
        done()
      } catch (error) { api.ui.toast({ message: String(error), variant: "error" }); editAdvanced(profile, done) }
    }} onCancel={done} />)
  }

  async function accountDetails(account: any) {
    const sid = currentSession()
    const binding = sid ? await bindings.get(sid) : undefined
    const options: TuiDialogSelectOption<string>[] = [
      { title: "Set active for current session", value: "active", disabled: !sid || !account.enabled },
      { title: "Set default for new sessions", value: "default", disabled: !account.enabled },
      { title: "Rename", value: "rename" },
      { title: account.enabled ? "Disable" : "Enable", value: "toggle" },
      { title: "Details", value: "details" },
      { title: "Refresh quota", value: "quota" },
      { title: "Reauthenticate in browser", value: "reauth" },
      { title: "Remove", value: "remove" },
      { title: "Back", value: "back" },
    ]
    select(`${account.label}${binding?.accountID === account.id ? " (active)" : ""}`, options, async (action) => {
      if (action === "back") return accountsDialog()
      if (action === "active" && sid) { await bindings.bind(sid, account.id, { pinnedByUser: true }); api.ui.toast({ message: "Account bound to current session", variant: "success" }); return accountsDialog() }
      if (action === "default") { await accounts.setDefault(account.id); return accountsDialog() }
      if (action === "toggle") { await accounts.setEnabled(account.id, !account.enabled); return accountsDialog() }
      if (action === "quota") { await quota.refresh(account, true).catch((error) => api.ui.toast({ message: String(error), variant: "error" })); return accountsDialog() }
      if (action === "details") {
        const affected = await bindings.affected(account.id)
        const quota = account.quota
        return dialog.replace(() => <DialogAlert title={account.label} message={`Email: ${account.email ?? "unknown"}\nWorkspace: ${account.workspaceAccountID ?? "unknown"}\nOrganization: ${account.organizationID ?? "unknown"}\nPlan: ${account.planType ?? "unknown"}\nEnabled: ${account.enabled ? "yes" : "no"}\nSessions: ${affected.length}\nPrimary: ${quota?.primary?.usedPercent ?? "?"}%${quota?.primary?.resetAt ? `, reset ${new Date(quota.primary.resetAt).toLocaleString()}` : ""}\nSecondary: ${quota?.secondary?.usedPercent ?? "?"}%${quota?.secondary?.resetAt ? `, reset ${new Date(quota.secondary.resetAt).toLocaleString()}` : ""}\nToken expires: ${new Date(account.expiresAt).toLocaleString()}\nSuccesses/failures: ${account.health.successes}/${account.health.failures}`} onConfirm={() => accountDetails(account)} />)
      }
      if (action === "rename") return dialog.replace(() => <DialogPrompt title="Rename account" value={account.label} onConfirm={async (label: string) => { await accounts.renameAccount(account.id, label); accountsDialog() }} onCancel={() => accountsDialog()} />)
      if (action === "reauth") return startOAuth(0)
      if (action === "remove") return dialog.replace(() => <DialogConfirm title="Remove account" message={`Remove ${account.label}? Affected idle sessions will receive handoff and automatic reassignment.`} onConfirm={async () => { await accounts.setEnabled(account.id, false); await actions.enqueueRemove(account.id); api.ui.toast({ message: "Removal queued safely", variant: "warning" }); accountsDialog() }} onCancel={() => accountDetails(account)} />)
    })
  }

  async function startOAuth(method: number) {
    dialog.clear()
    try {
      const before = await accounts.snapshot()
      const response = await api.client.provider.oauth.authorize({ providerID: POOL_PROVIDER_ID, directory: api.state.path.directory, method })
      const auth: any = response.data
      if (!auth?.url) throw new Error("OAuth authorization did not return a URL")
      openExternal(auth.url)
      api.ui.toast({ title: "Codex login", message: auth.instructions ?? "Complete authorization in the browser.", variant: "info", duration: 10000 })
      await api.client.provider.oauth.callback({ providerID: POOL_PROVIDER_ID, directory: api.state.path.directory, method })
      api.ui.toast({ title: "Codex login", message: "Account added or updated.", variant: "success" })
      const after = await accounts.snapshot()
      const added = after.accounts.find((item) => !before.accounts.some((previous) => previous.id === item.id)) ?? after.accounts.sort((a, b) => b.updatedAt - a.updatedAt)[0]
      if (added) dialog.replace(() => <DialogPrompt title="Account label (optional)" value={added.label} onConfirm={async (label: string) => { if (label.trim()) await accounts.renameAccount(added.id, label); accountsDialog() }} onCancel={() => accountsDialog()} />)
      else accountsDialog()
    } catch (error) { api.ui.toast({ title: "Codex login", message: String(error), variant: "error" }) }
  }

  async function addAccount() {
    select("Add Codex account", [
      { title: "Browser OAuth", description: "Recommended", value: 0 },
      { title: "Headless / device code", value: 1 },
      { title: "Cancel", value: -1 },
    ], (method) => { if (method >= 0) void startOAuth(method); else accountsDialog() })
  }

  async function accountsDialog() {
    const snapshot = await accounts.snapshot()
    const sid = currentSession()
    const binding = sid ? await bindings.get(sid) : undefined
    const rows: TuiDialogSelectOption<any>[] = snapshot.accounts.map((account) => {
      const primary = account.quota?.primary?.usedPercent
      const secondary = account.quota?.secondary?.usedPercent
      const blocked = blockedUntil(account)
      const quotaText = blocked > Date.now() ? `blocked until ${new Date(blocked).toLocaleTimeString()}` : primary !== undefined ? `${primary}% / ${secondary ?? "?"}%` : "quota unknown"
      return { title: `${binding?.accountID === account.id ? "●" : "○"} ${account.label}`, description: `${account.email ?? account.workspaceAccountID ?? ""} ${quotaText}${account.enabled ? "" : " disabled"}`, value: account }
    })
    rows.push({ title: "+ Add account", value: { add: true } })
    rows.push({ title: "Refresh all quotas", value: { refresh: true } })
    select("Codex Account Pool", rows, async (value) => {
      if (value.add) return addAccount()
      if (value.refresh) { await quota.refreshAll(true); return accountsDialog() }
      accountDetails(value)
    })
  }

  async function statusDialog() {
    const sid = currentSession()
    if (!sid) { api.ui.toast({ message: "Open a session first", variant: "warning" }); return }
    const binding = await bindings.get(sid)
    const account = (await accounts.snapshot()).accounts.find((item) => item.id === binding?.accountID)
    const enabled = (await settingsStore.get()).summarizer.enabled
    const summary = await handoff.summary(sid)
    const state = await handoff.state(sid)
    dialog.replace(() => <DialogAlert title="Codex handoff status" message={`Account: ${account?.label ?? "none"}\nEpoch: ${state.epoch?.epoch ?? binding?.epoch ?? 0}\nEpoch state: ${state.epoch?.state ?? "none"}\nSummarizer: ${enabled ? "enabled" : "disabled"}\nSummary revision: ${summary.revision}\nSummary model: ${summary.generatedBy ? `${summary.generatedBy.providerID}/${summary.generatedBy.modelID}` : "none"}`} onConfirm={() => dialog.clear()} />)
  }

  async function waitingDialog() {
    const waiting = (await jobs.snapshot()).jobs.filter((item) => !["completed", "cancelled"].includes(item.state))
    if (!waiting.length) { dialog.replace(() => <DialogAlert title="Waiting goals" message="No goals are waiting for Codex quota." onConfirm={() => dialog.clear()} />); return }
    select("Goals waiting for quota", waiting.map((job) => ({ title: `${job.sessionID} - ${job.state}`, description: `resume ${new Date(job.resumeAt).toLocaleString()} | account ${job.targetAccountID}`, value: job })), (job) => {
      dialog.replace(() => <DialogConfirm title="Cancel automatic resume?" message={`Cancel waiting job for ${job.sessionID}?`} onConfirm={async () => { await jobs.cancelSession(job.sessionID); waitingDialog() }} onCancel={() => waitingDialog()} />)
    })
  }

  const commands = [
    { title: "Codex: Configure handoff summarizer", value: "codex.handoff.config", category: "Codex", slash: { name: "codex-handoff-config" }, onSelect: () => void settingsDialog() },
    { title: "Codex: Manage accounts", value: "codex.accounts", category: "Codex", slash: { name: "codex-accounts" }, onSelect: () => void accountsDialog() },
    { title: "Codex: Handoff status", value: "codex.handoff.status", category: "Codex", slash: { name: "codex-handoff-status" }, onSelect: () => void statusDialog() },
    { title: "Codex: Goals waiting for quota", value: "codex.waiting", category: "Codex", slash: { name: "codex-waiting" }, onSelect: () => void waitingDialog() },
  ]
  api.command?.register(() => commands)
}

const module: TuiPluginModule & { id: string } = { id: "cybervinci-codex-account-pool", tui }
export default module
