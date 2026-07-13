import type { Account, Settings } from "./domain"
import { AccountStore } from "./store"
import { BindingStore, earliestAccount, selectAccount } from "./bindings"
import { blockedUntil, parseQuotaPayload, QuotaService } from "./quota"
import { DEFAULT_CODEX_ENDPOINT, DEFAULT_ISSUER, refreshTokens, tokenIdentity } from "./oauth"
import { FileLock } from "./storage"

export class AllAccountsExhaustedError extends Error {
  constructor(readonly account: Account | undefined, readonly resumeAt: number | undefined) { super("All enabled Codex accounts are exhausted"); this.name = "AllAccountsExhaustedError" }
}

export class NoAccountsAvailableError extends Error {
  constructor(readonly account: Account | undefined, readonly retryAt: number | undefined) { super("No enabled Codex account is currently available"); this.name = "NoAccountsAvailableError" }
}

export interface RotationOptions {
  settings: () => Promise<Settings>
  bindings?: BindingStore
  quota?: QuotaService
  issuer?: string
  codexApiEndpoint?: string
  fetch?: typeof globalThis.fetch
  onSelected?(sessionID: string | undefined, account: Account): void | Promise<void>
  onFailover?(sessionID: string | undefined, from: Account, to: Account | undefined, status: number): void | Promise<void>
  onAllExhausted?(sessionID: string | undefined, account: Account | undefined, resumeAt: number | undefined): void | Promise<void>
  prepareFailover?(input: { sessionID?: string; from: Account; to: Account; requestInput: RequestInfo | URL; init?: RequestInit }): Promise<{ requestInput?: RequestInfo | URL; init?: RequestInit } | void>
}

function retryAfter(response: Response, fallback: number) {
  const value = response.headers.get("retry-after")
  if (!value) return fallback
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? fallback : Math.max(0, date - Date.now())
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit) {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
}

function sessionID(input: RequestInfo | URL, init?: RequestInit) { return requestHeaders(input, init).get("session-id") ?? undefined }

function replayable(input: RequestInfo | URL, init?: RequestInit) {
  if (init?.body instanceof ReadableStream) return false
  return !(input instanceof Request && input.bodyUsed)
}

function requestSignal(input: RequestInfo | URL, init?: RequestInit) {
  return init?.signal ?? (input instanceof Request ? input.signal : undefined)
}

function cancellationName(error: unknown) {
  return error && typeof error === "object" && "name" in error ? String(error.name) : ""
}

function throwIfCancelled(input: RequestInfo | URL, init?: RequestInit) {
  const signal = requestSignal(input, init)
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError")
}

function cancelledByCaller(input: RequestInfo | URL, init: RequestInit | undefined, error: unknown) {
  if (requestSignal(input, init)?.aborted) return true
  return ["AbortError", "TimeoutError", "ProviderHeaderTimeoutError"].includes(cancellationName(error))
}

function cloneInput(input: RequestInfo | URL) { return input instanceof Request ? input.clone() : input }

export function createRotatingFetch(store: AccountStore, options: RotationOptions) {
  const issuer = options.issuer ?? DEFAULT_ISSUER
  const endpoint = options.codexApiEndpoint ?? DEFAULT_CODEX_ENDPOINT
  const baseFetch = options.fetch ?? globalThis.fetch
  const bindings = options.bindings ?? new BindingStore()
  const quota = options.quota ?? new QuotaService(store, baseFetch)
  const refreshes = new Map<string, Promise<Account>>()

  async function refresh(account: Account) {
    let pending = refreshes.get(account.id)
    if (!pending) {
      pending = (async () => {
        const lock = await FileLock.acquire(`refresh:${account.id}`, 15_000, 60_000)
        try {
          const latest = (await store.snapshot()).accounts.find((item) => item.id === account.id) ?? account
          if (latest.accessToken && latest.expiresAt > Date.now() + 30_000) return latest
          const tokens = await refreshTokens(latest.refreshToken, issuer)
          const identity = tokenIdentity(tokens)
          await store.updateTokens(latest.id, {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? latest.refreshToken,
            expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
            workspaceAccountID: identity.accountId ?? latest.workspaceAccountID,
            email: identity.email ?? latest.email,
          })
          return (await store.snapshot()).accounts.find((item) => item.id === latest.id)!
        } finally { await lock.release() }
      })().finally(() => refreshes.delete(account.id))
      refreshes.set(account.id, pending)
    }
    return pending
  }

  async function execute(account: Account, input: RequestInfo | URL, init?: RequestInit) {
    if (!account.accessToken || account.expiresAt <= Date.now() + 30_000) account = await refresh(account)
    const headers = requestHeaders(input, init)
    headers.delete("x-api-key")
    headers.delete("Authorization")
    headers.set("authorization", `Bearer ${account.accessToken}`)
    if (account.workspaceAccountID) headers.set("ChatGPT-Account-Id", account.workspaceAccountID)
    const source = input instanceof Request ? new URL(input.url) : new URL(input.toString())
    const url = source.pathname.includes("/v1/responses") || source.pathname.includes("/chat/completions") ? new URL(endpoint) : source
    if (input instanceof Request) return baseFetch(new Request(url, input), { ...init, headers })
    return baseFetch(url, { ...init, headers })
  }

  return async (originalInput: RequestInfo | URL, originalInit?: RequestInit): Promise<Response> => {
    throwIfCancelled(originalInput, originalInit)
    const sid = sessionID(originalInput, originalInit)
    const settings = await options.settings()
    const snapshot = await store.snapshot()
    const binding = sid ? await bindings.get(sid) : undefined
    const preferred = binding?.accountID ?? snapshot.defaultAccountID
    const now = Date.now()
    const first = selectAccount(snapshot.accounts, preferred, now)
    if (!first) {
      const enabled = snapshot.accounts.filter((item) => item.enabled)
      const earliest = earliestAccount(snapshot.accounts, now)
      const quotaExhausted = enabled.length > 0 && enabled.every((item) => blockedUntil(item, now) > now)
      if (quotaExhausted) {
        await options.onAllExhausted?.(sid, earliest?.account, earliest?.at)
        throw new AllAccountsExhaustedError(earliest?.account, earliest?.at)
      }
      throw new NoAccountsAvailableError(earliest?.account, earliest?.at)
    }
    const ordered = [first, ...snapshot.accounts.filter((item) => item.enabled && item.id !== first.id)]
      .filter((item) => blockedUntil(item, now) <= now && (item.health.cooldownUntil ?? 0) <= now)
    const attempts = replayable(originalInput, originalInit) ? Math.min(settings.rotation.maxAttempts, ordered.length) : 1
    let input = originalInput
    let init = originalInit
    let lastResponse: Response | undefined
    let lastError: unknown

    for (let index = 0; index < attempts; index++) {
      let account = ordered[index]
      throwIfCancelled(input, init)
      try {
        let reservation = await bindings.reserve(account.id, sid)
        let released = false
        const release = async () => { if (released) return; released = true; await bindings.releaseReservation(reservation.id) }
        let response: Response
        try { response = await execute(account, cloneInput(input), init) } catch (error) { await release(); throw error }
        if ((response.status === 401 || response.status === 403) && account.refreshToken) {
          await response.body?.cancel().catch(() => {})
          account = await refresh({ ...account, expiresAt: 0 })
          await release()
          reservation = await bindings.reserve(account.id, sid)
          released = false
          try { response = await execute(account, cloneInput(input), init) } catch (error) { await release(); throw error }
        }
        if (response.ok) {
          await store.recordOutcome(account.id, response.status, true)
          if (sid) await bindings.bind(sid, account.id)
          await options.onSelected?.(sid, account)
          if (!account.quota || Date.now() - account.quota.fetchedAt > settings.quota.pollIntervalMs) void quota.refresh(account).catch(() => {})
          if (!response.body) { await release(); return response }
          const reader = response.body.getReader()
          const body = new ReadableStream({
            async pull(controller) { try { const next = await reader.read(); if (next.done) { await release(); controller.close() } else controller.enqueue(next.value) } catch (error) { await release(); controller.error(error) } },
            async cancel(reason) { await reader.cancel(reason).catch(() => {}); await release() },
          })
          return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
        }
        lastResponse = response
        const retryable = response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500
        if (!retryable) { await store.recordOutcome(account.id, response.status, false); await release(); return response }
        let cooldown = response.status === 429 ? settings.rotation.rateLimitCooldownMs : settings.rotation.authFailureCooldownMs
        if (response.status === 429) {
          cooldown = retryAfter(response, cooldown)
          const parsed = parseQuotaPayload({}, Date.now())
          parsed.allowed = false; parsed.limitReached = true; parsed.source = "response"
          parsed.primary = { usedPercent: 100, resetAt: Date.now() + cooldown }
          await store.updateQuota(account.id, parsed)
        }
        await store.recordOutcome(account.id, response.status, false, Date.now() + cooldown)
        const next = ordered[index + 1]
        await options.onFailover?.(sid, account, next, response.status)
        if (!next || index + 1 >= attempts) {
          await release()
          if (response.status === 429) {
            const fresh = await store.snapshot()
            const earliest = earliestAccount(fresh.accounts)
            await options.onAllExhausted?.(sid, earliest?.account, earliest?.at)
          }
          return response
        }
        await response.body?.cancel().catch(() => {})
        await release()
        const prepared = await options.prepareFailover?.({ sessionID: sid, from: account, to: next, requestInput: input, init })
        input = prepared?.requestInput ?? input
        init = prepared?.init ?? init
      } catch (error) {
        if (cancelledByCaller(input, init, error)) {
          const signal = requestSignal(input, init)
          throw signal?.aborted ? signal.reason ?? error : error
        }
        lastError = error
        await store.recordOutcome(account.id, 0, false, Date.now() + settings.rotation.authFailureCooldownMs)
        const next = ordered[index + 1]
        await options.onFailover?.(sid, account, next, 0)
        if (next) {
          const prepared = await options.prepareFailover?.({ sessionID: sid, from: account, to: next, requestInput: input, init })
          input = prepared?.requestInput ?? input; init = prepared?.init ?? init
        }
      }
    }
    if (lastResponse) return lastResponse
    throw lastError ?? new Error("All Codex OAuth accounts failed")
  }
}
