import { hostname, homedir } from "node:os"
import { dirname, join } from "node:path"
import { existsSync } from "node:fs"
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import type { z } from "zod"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
const nativeRoot = join(dataHome, "cybervinci", "codex-account-pool")
const legacyRoot = join(dataHome, "opencode", "codex-account-pool")
const defaultRoot = existsSync(nativeRoot) || !existsSync(legacyRoot) ? nativeRoot : legacyRoot

export function dataRoot() {
  return process.env.CYBERVINCI_CODEX_DATA_DIR ?? process.env.OPENCODE_CODEX_DATA_DIR ?? defaultRoot
}

export const paths = {
  root: dataRoot(),
  settings: join(dataRoot(), "settings.json"),
  accounts: join(dataRoot(), "accounts.json"),
  legacyAccounts:
    process.env.CYBERVINCI_CODEX_ACCOUNTS_PATH ??
    process.env.OPENCODE_CODEX_ACCOUNTS_PATH ??
    join(dataHome, "opencode", "codex-account-pool.json"),
  bindings: join(dataRoot(), "bindings.json"),
  jobs: join(dataRoot(), "scheduler", "jobs.json"),
  actions: join(dataRoot(), "actions.json"),
  session(sessionID: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionID)) throw new Error("Invalid session ID")
    return join(dataRoot(), "sessions", sessionID)
  },
}

export class FileLock {
  private constructor(readonly path: string, readonly owner: string) {}

  static async acquire(key: string, timeoutMs = 10000, staleMs = 30000) {
    const directory = join(dataRoot(), "locks")
    await mkdir(directory, { recursive: true })
    const safe = key.replace(/[^a-zA-Z0-9_.-]/g, "_")
    const path = join(directory, `${safe}.lock`)
    const owner = `${hostname()}:${process.pid}:${randomUUID()}`
    const started = Date.now()
    for (;;) {
      try {
        const handle = await open(path, "wx", 0o600)
        await handle.writeFile(JSON.stringify({ owner, hostname: hostname(), pid: process.pid, createdAt: Date.now() }))
        await handle.close()
        return new FileLock(path, owner)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        const info = await stat(path).catch(() => undefined)
        if (!info || Date.now() - info.mtimeMs > staleMs) {
          await rm(path, { force: true }).catch(() => {})
          continue
        }
        if (Date.now() - started >= timeoutMs) throw new Error(`Timed out acquiring lock: ${key}`)
        await sleep(20 + Math.floor(Math.random() * 30))
      }
    }
  }

  async release() {
    const current = await readFile(this.path, "utf8").then(JSON.parse).catch(() => undefined)
    if (current?.owner === this.owner) await rm(this.path, { force: true }).catch(() => {})
  }
}

export async function atomicWrite(path: string, value: unknown, secret = false) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${hostname()}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: secret ? 0o600 : 0o644 })
  await rename(temp, path)
  if (secret) await chmod(path, 0o600).catch(() => {})
}

export async function readJson<T>(path: string, schema: z.ZodType<T>, fallback: () => T): Promise<T> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback()
    throw new Error(`Invalid plugin data file: ${path}`, { cause: error })
  }
}

const queues = new Map<string, Promise<unknown>>()

export function transact<T, R>(input: {
  key: string
  path: string
  schema: z.ZodType<T>
  fallback: () => T
  secret?: boolean
  update(value: T): R | Promise<R>
}): Promise<R> {
  const previous = queues.get(input.key) ?? Promise.resolve()
  const operation = previous.then(async () => {
    const lock = await FileLock.acquire(input.key)
    try {
      const value = await readJson(input.path, input.schema, input.fallback)
      const result = await input.update(value)
      await atomicWrite(input.path, value, input.secret)
      return result
    } finally {
      await lock.release()
    }
  })
  queues.set(input.key, operation.then(() => undefined, () => undefined))
  return operation
}
