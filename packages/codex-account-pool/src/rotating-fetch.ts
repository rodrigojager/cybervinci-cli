import type { Account, Settings } from "./domain"
import { AccountStore } from "./store"
import { BindingStore, earliestAccount, orderAccounts, rotateAccounts, selectAccount } from "./bindings"
import { blockedUntil, parseQuotaPayload, QuotaService } from "./quota"
import { DEFAULT_CODEX_ENDPOINT, DEFAULT_ISSUER, refreshTokens, tokenIdentity, TokenRefreshError } from "./oauth"
import { FileLock } from "./storage"

export class AllAccountsExhaustedError extends Error {
  constructor(readonly account: Account | undefined, readonly resumeAt: number | undefined) { super("All enabled Codex accounts are exhausted"); this.name = "AllAccountsExhaustedError" }
}

export class NoAccountsAvailableError extends Error {
  constructor(readonly account: Account | undefined, readonly retryAt: number | undefined) {
    super(account
      ? `Codex accounts are temporarily unavailable after request failures. Retry in ${Math.max(1, Math.ceil(((retryAt ?? Date.now()) - Date.now()) / 1000))}s${account.health.lastStatus === 401 ? " or reconnect the account in the Codex Account Pool" : ""}.`
      : "No enabled Codex account is configured. Connect or enable an account in the Codex Account Pool.")
    this.name = "NoAccountsAvailableError"
  }
}

export interface RotationOptions {
  settings: () => Promise<Settings>
  bindings?: BindingStore
  quota?: QuotaService
  streamCancelTimeoutMs?: number
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

export const STREAM_CANCEL_TIMEOUT_MS = 2_000

async function cancelWithDeadline(
  stream: { cancel(reason?: unknown): Promise<void> } | null | undefined,
  reason: unknown,
  timeoutMs: number,
) {
  if (!stream) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(() => stream.cancel(reason)).catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function createRotatingFetch(store: AccountStore, options: RotationOptions) {
  const issuer = options.issuer ?? DEFAULT_ISSUER
  const endpoint = options.codexApiEndpoint ?? DEFAULT_CODEX_ENDPOINT
  const baseFetch = options.fetch ?? globalThis.fetch
  const bindings = options.bindings ?? new BindingStore()
  const quota = options.quota ?? new QuotaService(store, baseFetch)
  const streamCancelTimeoutMs = options.streamCancelTimeoutMs ?? STREAM_CANCEL_TIMEOUT_MS
  async function refresh(account: Account, rejectedToken?: string): Promise<Account> {
    const lock = await FileLock.acquire(`refresh:${account.id}`, 20_000, 60_000)
    try {
      const latest = (await store.snapshot()).accounts.find((item) => item.id === account.id)
      if (!latest || !latest.enabled) throw new Error("Codex account was removed or disabled during token refresh")
      // Reload under the cross-process lock before spending a refresh token.
      // A 401 must refresh even a locally unexpired token unless another
      // process has already replaced the exact credential that was rejected.
      if (latest.accessToken && latest.expiresAt > Date.now() + 30_000 && latest.accessToken !== rejectedToken) return latest
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
  }

  async function execute(account: Account, input: RequestInfo | URL, init?: RequestInit) {
    if (!account.accessToken || account.expiresAt <= Date.now() + 30_000) account = await refresh(account)
    const headers = requestHeaders(input, init)
    headers.delete("x-api-key")
    headers.delete("Authorization")
    headers.delete("ChatGPT-Account-Id")
    headers.set("authorization", `Bearer ${account.accessToken}`)
    if (account.workspaceAccountID) headers.set("ChatGPT-Account-Id", account.workspaceAccountID)
    const source = input instanceof Request ? new URL(input.url) : new URL(input.toString())
    const url = source.pathname.includes("/v1/responses") || source.pathname.includes("/chat/completions") ? new URL(endpoint) : source
    const response = input instanceof Request
      ? await baseFetch(new Request(url, input), { ...init, headers })
      : await baseFetch(url, { ...init, headers })
    return { account, response }
  }

  return async (originalInput: RequestInfo | URL, originalInit?: RequestInit): Promise<Response> => {
    throwIfCancelled(originalInput, originalInit)
    const sid = sessionID(originalInput, originalInit)
    const settings = await options.settings()
    const snapshot = await store.snapshot()
    const binding = sid ? await bindings.get(sid) : undefined
    const preferred = binding?.accountID ?? snapshot.defaultAccountID
    const now = Date.now()
    const priority = rotateAccounts(orderAccounts(snapshot.accounts, snapshot.order), preferred)
    const first = selectAccount(priority, preferred, now)
    if (!first) {
      const enabled = priority.filter((item) => item.enabled)
      const earliest = earliestAccount(priority, now)
      const quotaExhausted = enabled.length > 0 && enabled.every((item) => blockedUntil(item, now) > now)
      if (quotaExhausted) {
        await options.onAllExhausted?.(sid, earliest?.account, earliest?.at)
        throw new AllAccountsExhaustedError(earliest?.account, earliest?.at)
      }
      throw new NoAccountsAvailableError(earliest?.account, earliest?.at)
    }
    const ordered = priority
      .filter((item) => item.enabled && blockedUntil(item, now) <= now && (item.health.cooldownUntil ?? 0) <= now)
    const attempts = replayable(originalInput, originalInit) ? Math.min(settings.rotation.maxAttempts, ordered.length) : 1
    let input = originalInput
    let init = originalInit

    for (let index = 0; index < attempts; index++) {
      let account = ordered[index]
      throwIfCancelled(input, init)
      const reservation = await bindings.reserve(account.id, sid)
      let released = false
      let streaming = false
      let response: Response | undefined
      const release = async () => { if (released) return; await bindings.releaseReservation(reservation.id); released = true }
      const next = index + 1 < attempts ? ordered[index + 1] : undefined
      try {
        try {
          const result = await execute(account, cloneInput(input), init)
          account = result.account
          response = result.response
          if (response.status === 401 && account.refreshToken && replayable(input, init)) {
            await cancelWithDeadline(response.body, undefined, streamCancelTimeoutMs)
            account = await refresh(account, account.accessToken)
            throwIfCancelled(input, init)
            const retry = await execute(account, cloneInput(input), init)
            account = retry.account
            response = retry.response
          }
        } catch (error) {
          if (cancelledByCaller(input, init, error)) {
            const signal = requestSignal(input, init)
            throw signal?.aborted ? signal.reason ?? error : error
          }
          // Local storage failures must not quarantine an authenticated account.
          const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
          if (["EPERM", "EACCES", "EBUSY", "ENOSPC", "EIO", "EROFS"].includes(code) || (error instanceof Error && error.message.startsWith("Invalid plugin data file:"))) throw error
          const status = error instanceof TokenRefreshError ? error.status : 0
          await store.recordOutcome(account.id, status, false, Date.now() + settings.rotation.authFailureCooldownMs)
          await release()
          await options.onFailover?.(sid, account, next, status)
          if (!next) throw error
          const prepared = await options.prepareFailover?.({ sessionID: sid, from: account, to: next, requestInput: input, init })
          input = prepared?.requestInput ?? input
          init = prepared?.init ?? init
          continue
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
            async cancel(reason) { await cancelWithDeadline(reader, reason, streamCancelTimeoutMs); await release() },
          })
          const result = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
          streaming = true
          return result
        }
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
        await options.onFailover?.(sid, account, next, response.status)
        if (!next) {
          await release()
          if (response.status === 429) {
            const fresh = await store.snapshot()
            const earliest = earliestAccount(orderAccounts(fresh.accounts, fresh.order))
            await options.onAllExhausted?.(sid, earliest?.account, earliest?.at)
          }
          return response
        }
        await cancelWithDeadline(response.body, undefined, streamCancelTimeoutMs)
        await release()
        const prepared = await options.prepareFailover?.({ sessionID: sid, from: account, to: next, requestInput: input, init })
        input = prepared?.requestInput ?? input
        init = prepared?.init ?? init
      } catch (error) {
        await cancelWithDeadline(response?.body, error, streamCancelTimeoutMs)
        throw error
      } finally {
        if (!streaming) await release()
      }
    }
    throw new Error("All Codex OAuth accounts failed")
  }
}
