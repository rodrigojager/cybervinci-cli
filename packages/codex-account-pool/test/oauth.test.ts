import { afterEach, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { browserAuthorization, cancelBrowserAuthorization } from "../src/oauth"

const roots: string[] = []
const servers: Server[] = []

async function close(target: Server) {
  if (!target.listening) return
  await new Promise<void>((resolve) => target.close(() => resolve()))
}

async function listen(target: Server) {
  servers.push(target)
  await new Promise<void>((resolve, reject) => {
    target.once("error", reject)
    target.listen(0, "127.0.0.1", () => resolve())
  })
  const address = target.address()
  if (!address || typeof address === "string") throw new Error("Test server did not expose a port")
  return address.port
}

async function unusedPort() {
  const probe = createServer()
  const port = await listen(probe)
  await close(probe)
  return port
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-oauth-"))
  roots.push(root)
  process.env.CYBERVINCI_CODEX_DATA_DIR = root
  const issuer = createServer((request, response) => {
    if (request.url !== "/oauth/token" || request.method !== "POST") {
      response.writeHead(404).end()
      return
    }
    request.resume()
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json", Connection: "close" })
      response.end(JSON.stringify({ id_token: "id", access_token: "access", refresh_token: "refresh", expires_in: 3600 }))
    })
  })
  const issuerPort = await listen(issuer)
  return `http://127.0.0.1:${issuerPort}`
}

async function complete(url: string) {
  const authorization = new URL(url)
  const callback = new URL(authorization.searchParams.get("redirect_uri")!)
  callback.hostname = "127.0.0.1"
  callback.searchParams.set("code", "authorization-code")
  callback.searchParams.set("state", authorization.searchParams.get("state")!)
  return fetch(callback)
}

afterEach(async () => {
  cancelBrowserAuthorization("OAuth test cleanup")
  await Promise.all(servers.splice(0).map(close))
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  delete process.env.CYBERVINCI_CODEX_DATA_DIR
})

test("browser OAuth falls back when the preferred callback port is occupied", async () => {
  const issuer = await fixture()
  const blocker = createServer((_request, response) => response.writeHead(404, { Connection: "close" }).end("occupied"))
  const preferredPort = await listen(blocker)
  const fallbackPort = await unusedPort()

  const authorization = await browserAuthorization(issuer, {
    ports: [preferredPort, fallbackPort],
    cancelRetries: 0,
    timeoutMs: 2_000,
  })
  expect(new URL(authorization.url).searchParams.get("redirect_uri")).toBe(`http://localhost:${fallbackPort}/auth/callback`)

  const [tokens, response] = await Promise.all([authorization.callback, complete(authorization.url)])
  expect(response.status).toBe(200)
  expect(tokens.refresh_token).toBe("refresh")

  const rebound = createServer()
  servers.push(rebound)
  await new Promise<void>((resolve, reject) => {
    rebound.once("error", reject)
    rebound.listen(fallbackPort, "127.0.0.1", () => resolve())
  })
  expect(rebound.listening).toBe(true)
})

test("a failed bind does not poison the next browser login attempt", async () => {
  const issuer = await fixture()
  const blocker = createServer((_request, response) => response.writeHead(404, { Connection: "close" }).end("occupied"))
  const port = await listen(blocker)

  await expect(browserAuthorization(issuer, { ports: [port], cancelRetries: 0, timeoutMs: 2_000 })).rejects.toThrow("Could not start")
  await close(blocker)

  const authorization = await browserAuthorization(issuer, { ports: [port], cancelRetries: 0, timeoutMs: 2_000 })
  const [tokens, response] = await Promise.all([authorization.callback, complete(authorization.url)])
  expect(response.status).toBe(200)
  expect(tokens.access_token).toBe("access")
})
