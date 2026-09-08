import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AccountStore } from "../src/store"
import { BindingStore, selectAccount } from "../src/bindings"
import { createRotatingFetch } from "../src/rotating-fetch"
import { defaultSettings } from "../src/domain"
import { atomicWrite } from "../src/storage"

const directories: string[] = []
const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(handler: (request: Request) => Response | Promise<Response>) {
  const directory = await mkdtemp(join(tmpdir(), "pool-auth-recovery-"))
  directories.push(directory)
  const store = new AccountStore(join(directory, "accounts.json"))
  const bindings = new BindingStore(join(directory, "bindings.json"))
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
  servers.push(server)
  const options = {
    bindings,
    settings: async () => defaultSettings(),
    issuer: server.url.origin,
    codexApiEndpoint: new URL("/responses", server.url).href,
  }
  const account = await store.add({ access: "old-access", refresh: "old-refresh", expires: Date.now() + 3_600_000, accountId: "workspace" })
  await store.updateQuota(account.id, { allowed: true, fetchedAt: Date.now(), source: "usage-endpoint" })
  return { store, bindings, account, options }
}

test("a 401 refreshes a rejected token even before its recorded expiry", async () => {
  let refreshes = 0
  const tokens: string[] = []
  const f = await fixture(async (request) => {
    if (new URL(request.url).pathname === "/oauth/token") {
      refreshes++
      expect((await request.formData()).get("refresh_token")).toBe("old-refresh")
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 })
    }
    const token = request.headers.get("authorization")!
    tokens.push(token)
    return token === "Bearer old-access" ? new Response("unauthorized", { status: 401 }) : new Response("ok")
  })
  const response = await createRotatingFetch(f.store, f.options)("https://api.openai.com/v1/responses")
  expect(response.status).toBe(200)
  expect(await response.text()).toBe("ok")
  expect(tokens).toEqual(["Bearer old-access", "Bearer new-access"])
  expect(refreshes).toBe(1)
  expect((await f.store.snapshot()).accounts[0].refreshToken).toBe("new-refresh")
  expect(await f.bindings.activeReservations(f.account.id)).toHaveLength(0)
})

test("independent pool instances share a refreshed token after concurrent 401s", async () => {
  let refreshes = 0
  let rejected = 0
  let ready!: () => void
  const bothRejected = new Promise<void>((resolve) => { ready = resolve })
  const f = await fixture(async (request) => {
    if (new URL(request.url).pathname === "/oauth/token") {
      refreshes++
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 })
    }
    if (request.headers.get("authorization") === "Bearer old-access") {
      if (++rejected === 2) ready()
      await bothRejected
      return new Response("unauthorized", { status: 401 })
    }
    return new Response("ok")
  })
  const responses = await Promise.all([1, 2].map(() => createRotatingFetch(new AccountStore(f.store.path), f.options)("https://api.openai.com/v1/responses")))
  expect(await Promise.all(responses.map((response) => response.text()))).toEqual(["ok", "ok"])
  expect(refreshes).toBe(1)
  expect(await f.bindings.activeReservations(f.account.id)).toHaveLength(0)
})

test("a failed refresh releases its reservation and fails over to a healthy account", async () => {
  let refreshes = 0
  const f = await fixture((request) => {
    if (new URL(request.url).pathname === "/oauth/token") {
      refreshes++
      return Response.json({ error: { code: "refresh_token_reused" } }, { status: 401 })
    }
    return request.headers.get("authorization") === "Bearer old-access" ? new Response("unauthorized", { status: 401 }) : new Response("ok")
  })
  const second = await f.store.add({ access: "second", refresh: "second-refresh", expires: Date.now() + 3_600_000 })
  await f.store.updateQuota(second.id, { allowed: true, fetchedAt: Date.now(), source: "usage-endpoint" })
  expect(await (await createRotatingFetch(f.store, f.options)("https://api.openai.com/v1/responses")).text()).toBe("ok")
  expect(await f.bindings.activeReservations(f.account.id)).toHaveLength(0)
  expect((await f.store.snapshot()).accounts[0].health.lastStatus).toBe(401)
  expect(refreshes).toBe(1)
})

test("a 403 fails over without refreshing tokens and clears inherited workspace headers", async () => {
  let refreshes = 0
  const f = await fixture((request) => {
    if (new URL(request.url).pathname === "/oauth/token") { refreshes++; return new Response("unexpected", { status: 500 }) }
    if (request.headers.get("authorization") === "Bearer old-access") return new Response("forbidden", { status: 403 })
    expect(request.headers.get("chatgpt-account-id")).toBeNull()
    return new Response("ok")
  })
  const second = await f.store.add({ access: "second", refresh: "r2", expires: Date.now() + 3_600_000 })
  await f.store.updateQuota(second.id, { allowed: true, fetchedAt: Date.now(), source: "usage-endpoint" })
  expect(await (await createRotatingFetch(f.store, f.options)("https://api.openai.com/v1/responses", { headers: { "ChatGPT-Account-Id": "inherited-workspace" } })).text()).toBe("ok")
  expect(refreshes).toBe(0)
})

test("a proactive refresh followed by 401 refreshes the actual rejected credential", async () => {
  const grants: string[] = []
  const f = await fixture(async (request) => {
    if (new URL(request.url).pathname === "/oauth/token") {
      grants.push(String((await request.formData()).get("refresh_token")))
      return Response.json({ access_token: `access-${grants.length}`, refresh_token: `refresh-${grants.length}`, expires_in: 3600 })
    }
    return request.headers.get("authorization") === "Bearer access-2" ? new Response("ok") : new Response("unauthorized", { status: 401 })
  })
  await f.store.updateTokens(f.account.id, { expiresAt: 0 })
  expect(await (await createRotatingFetch(f.store, f.options)("https://api.openai.com/v1/responses")).text()).toBe("ok")
  expect(grants).toEqual(["old-refresh", "refresh-1"])
})

test("a refresh failure honors maxAttempts and explains reconnection without exposing response secrets", async () => {
  const f = await fixture((request) => new URL(request.url).pathname === "/oauth/token"
    ? Response.json({ error: { code: "refresh_token_reused", message: "secret-response-value" } }, { status: 401 })
    : new Response("unauthorized", { status: 401 }))
  await f.store.add({ access: "second", refresh: "r2", expires: Date.now() + 3_600_000 })
  const settings = defaultSettings()
  settings.rotation.maxAttempts = 1
  let handoffs = 0
  const rotating = createRotatingFetch(f.store, { ...f.options, settings: async () => settings, async prepareFailover() { handoffs++ } })
  let caught: unknown
  try { await rotating("https://api.openai.com/v1/responses") } catch (error) { caught = error }
  expect(String(caught)).toContain("refresh token was already used")
  expect(String(caught)).toContain("reconnect")
  expect(String(caught)).not.toContain("secret-response-value")
  expect(handoffs).toBe(0)
  expect((await f.store.snapshot()).accounts[1].health.failures).toBe(0)
  expect(await f.bindings.activeReservations(f.account.id)).toHaveLength(0)
})

test("reconnecting an account clears authentication cooldown immediately without erasing quota", async () => {
  const f = await fixture(() => new Response("ok"))
  await f.store.recordOutcome(f.account.id, 0, false, Date.now() + 300_000)
  const account = await f.store.add({ access: "new", refresh: "new-refresh", expires: Date.now() + 3_600_000, accountId: "workspace" })
  expect(account.id).toBe(f.account.id)
  expect(selectAccount((await f.store.snapshot()).accounts)?.id).toBe(f.account.id)
  expect(account.quota?.allowed).toBe(true)
  expect(account.health.failures).toBe(1)
})

test("a local persistence failure after HTTP 200 does not penalize or rotate healthy accounts", async () => {
  const f = await fixture(() => new Response("ok"))
  const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" })
  class FailingStore extends AccountStore {
    override async recordOutcome(id: string, status: number, ok: boolean, cooldown?: number) {
      if (ok) throw failure
      return super.recordOutcome(id, status, ok, cooldown)
    }
  }
  await expect(createRotatingFetch(new FailingStore(f.store.path), f.options)("https://api.openai.com/v1/responses")).rejects.toBe(failure)
  expect((await f.store.snapshot()).accounts[0].health.failures).toBe(0)
  expect(await f.bindings.activeReservations(f.account.id)).toHaveLength(0)
})

test.skipIf(process.platform !== "win32")("atomic writes survive a transient Windows reader that denies rename", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pool-windows-write-"))
  directories.push(directory)
  const path = join(directory, "accounts.json")
  await atomicWrite(path, { revision: 1 }, true)
  const process = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "$file = [IO.File]::Open($env:POOL_TEST_FILE, 'Open', 'Read', 'Read'); try { [Console]::WriteLine('locked'); Start-Sleep -Milliseconds 400 } finally { $file.Dispose() }"], {
    env: { ...Bun.env, POOL_TEST_FILE: path }, stdout: "pipe", stderr: "pipe",
  })
  try {
    const reader = process.stdout.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked")
    reader.releaseLock()
    await atomicWrite(path, { revision: 2 }, true)
    expect(await Bun.file(path).json()).toEqual({ revision: 2 })
  } finally {
    await process.exited
  }
})
