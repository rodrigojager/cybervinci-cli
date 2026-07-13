import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AccountStore } from "../src/store"
import { createRotatingFetch, NoAccountsAvailableError } from "../src/rotating-fetch"
import { defaultSettings } from "../src/domain"

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

test("rotates to the next account after a 429", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-fetch-"))
  directories.push(directory)
  const store = new AccountStore(join(directory, "accounts.json"))
  const first = await store.add({ access: "first", refresh: "r1", expires: Date.now() + 60_000 })
  await store.add({ access: "second", refresh: "r2", expires: Date.now() + 60_000 })
  await store.setActive(first.id)

  const request = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const token = new Headers(init?.headers).get("authorization")
    return token === "Bearer first" ? new Response("limited", { status: 429 }) : new Response("ok")
  })
  const rotating = createRotatingFetch(store, { fetch: request as unknown as typeof fetch, settings: async () => defaultSettings() })
  const response = await rotating("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })

  expect(response.status).toBe(200)
  await response.text()
  expect(request).toHaveBeenCalledTimes(3) // two model attempts plus the asynchronous quota refresh
  const snapshot = await store.snapshot()
  expect(snapshot.accounts.find((item) => item.id === first.id)?.health.lastStatus).toBe(429)
  expect(snapshot.accounts.find((item) => item.id !== first.id)?.health.successes).toBe(1)
})

test("reports all accounts exhausted after the final 429", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-exhausted-"))
  directories.push(directory)
  const store = new AccountStore(join(directory, "accounts.json"))
  await store.add({ access: "first", refresh: "r1", expires: Date.now() + 60_000 })
  await store.add({ access: "second", refresh: "r2", expires: Date.now() + 60_000 })
  const exhausted = mock(() => {})
  const request = mock(async () => new Response("limited", { status: 429, headers: { "retry-after": "60" } }))
  const rotating = createRotatingFetch(store, { fetch: request as unknown as typeof fetch, settings: async () => defaultSettings(), onAllExhausted: exhausted })
  const response = await rotating("https://api.openai.com/v1/responses", { method: "POST", body: "{}", headers: { "session-id": "ses_a" } })
  expect(response.status).toBe(429)
  expect(exhausted).toHaveBeenCalledTimes(1)
})

test("holds a cross-process reservation until the response stream is consumed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-reservation-"))
  directories.push(directory)
  const store = new AccountStore(join(directory, "accounts.json"))
  const account = await store.add({ access: "first", refresh: "r1", expires: Date.now() + 60_000 })
  const { BindingStore } = await import("../src/bindings")
  const bindings = new BindingStore(join(directory, "bindings.json"))
  const request = mock(async (url: RequestInfo | URL) => String(url).includes("wham/usage") ? new Response(JSON.stringify({ rate_limit: { allowed: true } })) : new Response("streamed"))
  const rotating = createRotatingFetch(store, { fetch: request as unknown as typeof fetch, bindings, settings: async () => defaultSettings() })
  const response = await rotating("https://api.openai.com/v1/responses", { headers: { "session-id": "ses_a" } })
  expect(await bindings.activeReservations(account.id)).toHaveLength(1)
  expect(await response.text()).toBe("streamed")
  expect(await bindings.activeReservations(account.id)).toHaveLength(0)
})

test("does not poison accounts when the caller aborts with a provider timeout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-caller-timeout-"))
  directories.push(directory)
  const store = new AccountStore(join(directory, "accounts.json"))
  await store.add({ access: "first", refresh: "r1", expires: Date.now() + 60_000 })
  await store.add({ access: "second", refresh: "r2", expires: Date.now() + 60_000 })
  const controller = new AbortController()
  const timeout = Object.assign(new Error("Provider response headers timed out after 10000ms"), { name: "ProviderHeaderTimeoutError" })
  let modelCalls = 0
  const request = mock(async (url: RequestInfo | URL) => {
    if (String(url).includes("/wham/usage")) return new Response(JSON.stringify({ rate_limit: { allowed: true } }))
    modelCalls++
    if (modelCalls === 1) { controller.abort(timeout); throw timeout }
    return new Response("ok")
  })
  const rotating = createRotatingFetch(store, { fetch: request as unknown as typeof fetch, settings: async () => defaultSettings() })

  let caught: unknown
  try { await rotating("https://api.openai.com/v1/responses", { signal: controller.signal }) } catch (error) { caught = error }
  expect(caught).toBe(timeout)
  expect(modelCalls).toBe(1)
  let snapshot = await store.snapshot()
  expect(snapshot.accounts.every((item) => item.health.failures === 0 && item.health.cooldownUntil === undefined)).toBe(true)

  const response = await rotating("https://api.openai.com/v1/responses")
  expect(await response.text()).toBe("ok")
  expect(modelCalls).toBe(2)
  snapshot = await store.snapshot()
  expect(snapshot.accounts.some((item) => item.health.successes === 1)).toBe(true)
})

test("does not start a request when its signal is already aborted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-already-aborted-"))
  directories.push(directory)
  const store = new AccountStore(join(directory, "accounts.json"))
  await store.add({ access: "first", refresh: "r1", expires: Date.now() + 60_000 })
  const request = mock(async () => new Response("unexpected"))
  const rotating = createRotatingFetch(store, { fetch: request as unknown as typeof fetch, settings: async () => defaultSettings() })
  const controller = new AbortController()
  const reason = new Error("caller stopped")
  controller.abort(reason)

  let caught: unknown
  try { await rotating("https://api.openai.com/v1/responses", { signal: controller.signal }) } catch (error) { caught = error }
  expect(caught).toBe(reason)
  expect(request).not.toHaveBeenCalled()
  expect((await store.snapshot()).accounts[0].health.failures).toBe(0)
})

test("still fails over and cools down a real transport failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-transport-failure-"))
  directories.push(directory)
  const store = new AccountStore(join(directory, "accounts.json"))
  const first = await store.add({ access: "first", refresh: "r1", expires: Date.now() + 60_000 })
  await store.add({ access: "second", refresh: "r2", expires: Date.now() + 60_000 })
  await store.setActive(first.id)
  const request = mock(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("/wham/usage")) return new Response(JSON.stringify({ rate_limit: { allowed: true } }))
    if (new Headers(init?.headers).get("authorization") === "Bearer first") throw new Error("ECONNRESET")
    return new Response("ok")
  })
  const rotating = createRotatingFetch(store, { fetch: request as unknown as typeof fetch, settings: async () => defaultSettings() })

  expect(await (await rotating("https://api.openai.com/v1/responses")).text()).toBe("ok")
  const snapshot = await store.snapshot()
  const failed = snapshot.accounts.find((item) => item.id === first.id)!
  expect(failed.health.lastStatus).toBe(0)
  expect(failed.health.cooldownUntil).toBeGreaterThan(Date.now())
  expect(snapshot.accounts.find((item) => item.id !== first.id)?.health.successes).toBe(1)
})

test("does not report quota exhaustion when accounts are only cooling down", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-temporarily-unavailable-"))
  directories.push(directory)
  const store = new AccountStore(join(directory, "accounts.json"))
  const first = await store.add({ access: "first", refresh: "r1", expires: Date.now() + 60_000 })
  const second = await store.add({ access: "second", refresh: "r2", expires: Date.now() + 60_000 })
  const retryAt = Date.now() + 60_000
  await store.recordOutcome(first.id, 0, false, retryAt)
  await store.recordOutcome(second.id, 0, false, retryAt)
  const request = mock(async () => new Response("unexpected"))
  const exhausted = mock(() => {})
  const rotating = createRotatingFetch(store, { fetch: request as unknown as typeof fetch, settings: async () => defaultSettings(), onAllExhausted: exhausted })

  let caught: unknown
  try { await rotating("https://api.openai.com/v1/responses") } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(NoAccountsAvailableError)
  expect((caught as NoAccountsAvailableError).retryAt).toBe(retryAt)
  expect(exhausted).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
})
