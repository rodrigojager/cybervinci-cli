import { createServer, type Server } from "node:http"
import { FileLock } from "./storage"

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const DEFAULT_ISSUER = "https://auth.openai.com"
export const DEFAULT_CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const OAUTH_PORTS = [1455, 1457] as const
const OAUTH_CALLBACK_PATH = "/auth/callback"
const OAUTH_TIMEOUT_MS = 5 * 60_000

export interface BrowserAuthorizationOptions {
  ports?: readonly number[]
  timeoutMs?: number
  cancelRetries?: number
  cancelRetryMs?: number
}

export interface OAuthTokens {
  id_token?: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

export interface TokenIdentity {
  accountId?: string
  email?: string
  subjectID?: string
  organizationID?: string
}

interface PkceCodes {
  verifier: string
  challenge: string
}

interface PendingOAuth {
  pkce: PkceCodes
  state: string
  resolve(tokens: OAuthTokens): void
  reject(error: Error): void
}

let server: Server | undefined
let pending: PendingOAuth | undefined

function base64Url(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64url")
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)).buffer)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64Url(digest) }
}

function parseClaims(token?: string): Record<string, unknown> | undefined {
  if (!token) return
  const parts = token.split(".")
  if (parts.length !== 3) return
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch {
    return
  }
}

export function tokenIdentity(tokens: Pick<OAuthTokens, "id_token" | "access_token">): TokenIdentity {
  const claims = parseClaims(tokens.id_token) ?? parseClaims(tokens.access_token)
  if (!claims) return {}
  const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined
  const organizations = claims.organizations as Array<{ id?: string }> | undefined
  return {
    accountId:
      (claims.chatgpt_account_id as string | undefined) ??
      (auth?.chatgpt_account_id as string | undefined) ??
      organizations?.[0]?.id,
    email: claims.email as string | undefined,
    subjectID: claims.sub as string | undefined,
    organizationID: organizations?.[0]?.id,
  }
}

export async function refreshTokens(refreshToken: string, issuer = DEFAULT_ISSUER): Promise<OAuthTokens> {
  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`)
  return response.json() as Promise<OAuthTokens>
}

async function exchangeCode(code: string, redirectUri: string, pkce: PkceCodes, issuer: string) {
  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`)
  return response.json() as Promise<OAuthTokens>
}

function redirectUri(port: number) {
  return `http://localhost:${port}${OAUTH_CALLBACK_PATH}`
}

function stopServer() {
  const current = server
  server = undefined
  pending = undefined
  current?.close()
}

export function cancelBrowserAuthorization(message = "OAuth login cancelled") {
  const current = pending
  if (current) current.reject(new Error(message))
  else stopServer()
}

async function cancelExistingLogin(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/cancel`, {
      headers: { Connection: "close" },
      signal: AbortSignal.timeout(750),
    })
    await response.text().catch(() => "")
  } catch {
    // The listener may not be an OAuth server. The registered fallback port is tried next.
  }
}

function oauthServer(issuer: string, port: number) {
  const callbackUrl = redirectUri(port)
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://localhost:${port}`)
    if (url.pathname === "/cancel") {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" }).end("Login cancelled")
      const current = pending
      if (current) current.reject(new Error("OAuth login cancelled by a newer login attempt"))
      else stopServer()
      return
    }
    if (url.pathname !== OAUTH_CALLBACK_PATH) {
      response.writeHead(404, { Connection: "close" }).end("Not found")
      return
    }

    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
    if (error || !code || !pending || state !== pending.state) {
      const message = error ?? (!code ? "Missing authorization code" : "Invalid OAuth state")
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" }).end(message)
      const current = pending
      if (current) current.reject(new Error(message))
      else stopServer()
      return
    }

    const current = pending
    pending = undefined
    void exchangeCode(code, callbackUrl, current.pkce, issuer).then(
      (tokens) => {
        response
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" })
          .end("<h1>CyberVinci autorizado</h1><p>Voce pode fechar esta janela.</p>")
        current.resolve(tokens)
      },
      (cause) => {
        const message = cause instanceof Error ? cause.message : "Token exchange failed"
        response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" }).end(message)
        current.reject(cause instanceof Error ? cause : new Error(message))
      },
    )
  })
}

async function listen(issuer: string, port: number): Promise<Server> {
  const candidate = oauthServer(issuer, port)
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      candidate.once("error", onError)
      candidate.listen(port, "127.0.0.1", () => {
        candidate.off("error", onError)
        resolve()
      })
    })
    return candidate
  } catch (error) {
    candidate.removeAllListeners()
    candidate.close()
    throw error
  }
}

async function startServer(issuer: string, options: BrowserAuthorizationOptions): Promise<string> {
  const address = server?.address()
  if (server?.listening && address && typeof address !== "string") return redirectUri(address.port)
  if (server) stopServer()

  const ports = options.ports?.length ? options.ports : OAUTH_PORTS
  const retries = Math.max(options.cancelRetries ?? 5, 0)
  const retryMs = Math.max(options.cancelRetryMs ?? 150, 0)
  let lastError: unknown
  for (const port of ports) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        server = await listen(issuer, port)
        return redirectUri(port)
      } catch (error) {
        lastError = error
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error
        if (attempt === 0) await cancelExistingLogin(port)
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, retryMs))
      }
    }
  }
  const detail = lastError instanceof Error ? ` (${lastError.message})` : ""
  throw new Error(`Could not start the Codex OAuth callback on ports ${ports.join(" or ")}${detail}. Close stale CyberVinci processes or use device login.`)
}

export async function browserAuthorization(issuer = DEFAULT_ISSUER, options: BrowserAuthorizationOptions = {}) {
  const loginLock = await FileLock.acquire("oauth-login", 1000, 10 * 60_000).catch(() => {
    throw new Error("Another Codex browser login is already in progress")
  })
  let redirectUri: string
  try { redirectUri = await startServer(issuer, options) } catch (error) { stopServer(); await loginLock.release(); throw error }
  const pkce = await generatePKCE()
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)).buffer)
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode",
  })
  const callback = new Promise<OAuthTokens>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stopServer()
      void loginLock.release()
      reject(new Error("OAuth callback timed out"))
    }, options.timeoutMs ?? OAUTH_TIMEOUT_MS)
    pending = {
      pkce,
      state,
      resolve(tokens) {
        clearTimeout(timeout)
        stopServer()
        void loginLock.release()
        resolve(tokens)
      },
      reject(error) {
        clearTimeout(timeout)
        stopServer()
        void loginLock.release()
        reject(error)
      },
    }
  })
  return { url: `${issuer}/oauth/authorize?${params}`, callback }
}

export async function deviceAuthorization(issuer = DEFAULT_ISSUER) {
  const response = await fetch(`${issuer}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "opencode" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  })
  if (!response.ok) throw new Error(`Device authorization failed: ${response.status}`)
  const data = (await response.json()) as { device_auth_id: string; user_code: string; interval: string }
  const interval = Math.max(Number.parseInt(data.interval) || 5, 1) * 1000

  return {
    url: `${issuer}/codex/device`,
    code: data.user_code,
    async callback(): Promise<OAuthTokens> {
      const started = Date.now()
      for (;;) {
        if (Date.now() - started >= 10 * 60_000) throw new Error("Device login timed out")
        const poll = await fetch(`${issuer}/api/accounts/deviceauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": "opencode" },
          body: JSON.stringify({ device_auth_id: data.device_auth_id, user_code: data.user_code }),
          signal: AbortSignal.timeout(15_000),
        })
        if (poll.ok) {
          const result = (await poll.json()) as { authorization_code: string; code_verifier: string }
          return exchangeCode(
            result.authorization_code,
            `${issuer}/deviceauth/callback`,
            { verifier: result.code_verifier, challenge: "" },
            issuer,
          )
        }
        if (poll.status !== 403 && poll.status !== 404) throw new Error(`Device login failed: ${poll.status}`)
        await Bun.sleep(interval + 3000)
      }
    },
  }
}
