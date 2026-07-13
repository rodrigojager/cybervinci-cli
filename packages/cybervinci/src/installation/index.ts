import { LayerNode } from "@cybervinci-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@cybervinci-ai/core/effect/app-node-builder"
import { httpClient } from "@cybervinci-ai/core/effect/app-node-platform"
import { Effect, Layer, Schema, Context, Stream } from "effect"
import { serviceUse } from "@cybervinci-ai/core/effect/service-use"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { errorMessage } from "@/util/error"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@cybervinci-ai/core/process"
import path from "path"
import { makeRuntime } from "@cybervinci-ai/core/effect/runtime"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "@cybervinci-ai/core/installation/version"

import { InstallationEvent } from "@cybervinci-ai/schema/installation-event"

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = InstallationEvent

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  return `cybervinci/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

// Explicit release APIs must return a GitHub-compatible tag name.
const GitHubRelease = Schema.Struct({ tag_name: Schema.String })

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@cybervinci/Installation") {}

export const use = serviceUse(Service)

const layer: Layer.Layer<Service, never, HttpClient.HttpClient | AppProcess.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
    const appProcess = yield* AppProcess.Service

    const text = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return result.stdout.toString("utf8")
      },
      Effect.catch(() => Effect.succeed("")),
    )

    const run = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.catch((err) => Effect.succeed({ code: 1, stdout: "", stderr: errorMessage(err) })),
    )


    const upgradeFailure = (method: Method, result?: { code: number; stdout: string; stderr: string }) => {
      if (method === "choco") return "not running from an elevated command shell"
      if (result) return `Upgrade failed for ${method} (exit code ${result.code}).`
      return `Upgrade failed for ${method}.`
    }

    const upgradeScriptShell = Effect.fnUntraced(function* () {
      const bashVersion = yield* text(["bash", "--version"])
      if (bashVersion) return "bash"
      return "sh"
    })

    const upgradeCurl = Effect.fnUntraced(
      function* (target: string) {
        const installerURL = process.env.CYBERVINCI_INSTALL_SCRIPT_URL?.trim()
        if (!installerURL) {
          return yield* new UpgradeFailedError({
            stderr: "CYBERVINCI_INSTALL_SCRIPT_URL is required for installer-based updates.",
          })
        }
        const response = yield* httpOk.execute(HttpClientRequest.get(installerURL))
        const body = yield* response.text
        const bodyBytes = new TextEncoder().encode(body)
        const shell = yield* upgradeScriptShell()
        const result = yield* appProcess.run(
          ChildProcess.make(shell, [], {
            stdin: Stream.make(bodyBytes),
            env: { VERSION: target },
            extendEnv: true,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.mapError((error) =>
        error instanceof UpgradeFailedError ? error : new UpgradeFailedError({ stderr: upgradeFailure("curl") }),
      ),
    )

    const result: Interface = {
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest(),
        }
      }),
      method: Effect.fn("Installation.method")(function* () {
        if (process.execPath.includes(path.join(".cybervinci", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
        const exec = process.execPath.toLowerCase()

        const checks: Array<{ name: Method; command: () => Effect.Effect<string> }> = [
          { name: "npm", command: () => text(["npm", "list", "-g", "--depth=0"]) },
          { name: "yarn", command: () => text(["yarn", "global", "list"]) },
          { name: "pnpm", command: () => text(["pnpm", "list", "-g", "--depth=0"]) },
          { name: "bun", command: () => text(["bun", "pm", "ls", "-g"]) },
          { name: "brew", command: () => text(["brew", "list", "--formula", "cybervinci"]) },
          { name: "scoop", command: () => text(["scoop", "list", "cybervinci"]) },
          { name: "choco", command: () => text(["choco", "list", "--limit-output", "cybervinci"]) },
        ]

        checks.sort((a, b) => {
          const aMatches = exec.includes(a.name)
          const bMatches = exec.includes(b.name)
          if (aMatches && !bMatches) return -1
          if (!aMatches && bMatches) return 1
          return 0
        })

        for (const check of checks) {
          const output = yield* check.command()
          const installedName = "cybervinci"
          if (output.includes(installedName)) {
            return check.name
          }
        }

        return "unknown" as Method
      }),
      latest: Effect.fn("Installation.latest")(function* (_installMethod?: Method) {
        if (process.env.CYBERVINCI_ENABLE_EXTERNAL_UPDATES !== "true") return InstallationVersion
        const releaseAPI = process.env.CYBERVINCI_RELEASE_API_URL?.trim()
        if (!releaseAPI) return InstallationVersion
        const response = yield* httpOk.execute(
          HttpClientRequest.get(releaseAPI).pipe(HttpClientRequest.acceptJson),
        )
        const data = yield* HttpClientResponse.schemaBodyJson(GitHubRelease)(response)
        return data.tag_name.replace(/^v/, "")
      }, Effect.orDie),
      upgrade: Effect.fn("Installation.upgrade")(function* (m: Method, target: string) {
        if (process.env.CYBERVINCI_ENABLE_EXTERNAL_UPDATES !== "true") {
          return yield* new UpgradeFailedError({
            stderr:
              "CYBERVINCI updates are disabled. Set CYBERVINCI_ENABLE_EXTERNAL_UPDATES=true only with explicit trusted feed and package targets.",
          })
        }
        let upgradeResult: { code: number; stdout: string; stderr: string } | undefined
        switch (m) {
          case "curl":
            upgradeResult = yield* upgradeCurl(target)
            break
          case "npm":
          case "yarn":
          case "pnpm":
          case "bun": {
            const packageName = process.env.CYBERVINCI_NPM_PACKAGE?.trim()
            if (!packageName) {
              return yield* new UpgradeFailedError({
                stderr: "CYBERVINCI_NPM_PACKAGE is required for package-manager updates.",
              })
            }
            const command =
              m === "npm"
                ? ["npm", "install", "-g", `${packageName}@${target}`]
                : m === "yarn"
                  ? ["yarn", "global", "add", `${packageName}@${target}`]
                  : m === "pnpm"
                    ? ["pnpm", "install", "-g", `${packageName}@${target}`]
                    : ["bun", "install", "-g", `${packageName}@${target}`]
            upgradeResult = yield* run(command)
            break
          }
          case "brew": {
            const formula = process.env.CYBERVINCI_HOMEBREW_FORMULA?.trim()
            if (!formula) {
              return yield* new UpgradeFailedError({
                stderr: "CYBERVINCI_HOMEBREW_FORMULA is required for Homebrew updates.",
              })
            }
            const env = { HOMEBREW_NO_AUTO_UPDATE: "1" }
            upgradeResult = yield* run(["brew", "upgrade", formula], { env })
            break
          }
          case "choco": {
            const packageName = process.env.CYBERVINCI_CHOCO_PACKAGE?.trim()
            if (!packageName) {
              return yield* new UpgradeFailedError({
                stderr: "CYBERVINCI_CHOCO_PACKAGE is required for Chocolatey updates.",
              })
            }
            upgradeResult = yield* run(["choco", "upgrade", packageName, `--version=${target}`, "-y"])
            break
          }
          case "scoop": {
            const packageName = process.env.CYBERVINCI_SCOOP_PACKAGE?.trim()
            if (!packageName) {
              return yield* new UpgradeFailedError({
                stderr: "CYBERVINCI_SCOOP_PACKAGE is required for Scoop updates.",
              })
            }
            upgradeResult = yield* run(["scoop", "install", `${packageName}@${target}`])
            break
          }
          default:
            return yield* new UpgradeFailedError({ stderr: `Unknown installation method: ${m}` })
        }
        if (!upgradeResult || upgradeResult.code !== 0) {
          return yield* new UpgradeFailedError({ stderr: upgradeFailure(m, upgradeResult) })
        }
        yield* Effect.logInfo("upgraded", {
          method: m,
          target,
          stdout: upgradeResult.stdout,
          stderr: upgradeResult.stderr,
        })
        yield* text([process.execPath, "--version"])
      }),
    }

    return Service.of(result)
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [httpClient, AppProcess.node] })

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."
