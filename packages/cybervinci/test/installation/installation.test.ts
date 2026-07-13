import { afterEach, beforeEach, describe, expect } from "bun:test"
import { makeGlobalNode } from "@cybervinci-ai/core/effect/app-node"
import { LayerNode } from "@cybervinci-ai/core/effect/layer-node"
import { httpClient } from "@cybervinci-ai/core/effect/app-node-platform"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationVersion } from "@cybervinci-ai/core/installation/version"
import { CrossSpawnSpawner } from "@cybervinci-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()
const updateEnv = [
  "CYBERVINCI_ENABLE_EXTERNAL_UPDATES",
  "CYBERVINCI_RELEASE_API_URL",
  "CYBERVINCI_INSTALL_SCRIPT_URL",
  "CYBERVINCI_NPM_PACKAGE",
  "CYBERVINCI_HOMEBREW_FORMULA",
  "CYBERVINCI_CHOCO_PACKAGE",
  "CYBERVINCI_SCOOP_PACKAGE",
] as const

beforeEach(() => {
  process.env.CYBERVINCI_ENABLE_EXTERNAL_UPDATES = "true"
})

afterEach(() => {
  for (const name of updateEnv) delete process.env[name]
})

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(
  handler: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string } = () =>
    "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string },
) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(spawnHandler),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttpClient(httpHandler)],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

describe("installation", () => {
  describe("latest", () => {
    let calls = 0
    testEffect(
      testLayer(() => {
        calls++
        return jsonResponse({ tag_name: "v9.9.9" })
      }),
    ).effect("does not contact a feed when external updates are disabled", () =>
      Effect.gen(function* () {
        delete process.env.CYBERVINCI_ENABLE_EXTERNAL_UPDATES
        process.env.CYBERVINCI_RELEASE_API_URL = "https://release.invalid/latest"
        const result = yield* Installation.use.latest("unknown")
        expect(result).toBe(InstallationVersion)
        expect(calls).toBe(0)
      }),
    )

    const urls: string[] = []
    testEffect(
      testLayer((request) => {
        urls.push(request.url)
        return jsonResponse({ tag_name: "v4.0.0-beta.1" })
      }),
    ).effect("uses only the explicit release API", () =>
      Effect.gen(function* () {
        process.env.CYBERVINCI_RELEASE_API_URL = "https://releases.example.test/latest"
        const result = yield* Installation.use.latest("npm")
        expect(result).toBe("4.0.0-beta.1")
        expect(urls).toEqual(["https://releases.example.test/latest"])
      }),
    )

    let implicitCalls = 0
    testEffect(
      testLayer(() => {
        implicitCalls++
        return jsonResponse({ version: "1.5.0" })
      }),
    ).effect("does not infer public package feeds", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("npm")
        expect(result).toBe(InstallationVersion)
        expect(implicitCalls).toBe(0)
      }),
    )
  })

  describe("upgrade", () => {
    testEffect(testLayer(() => jsonResponse({}))).effect("requires an explicit package target", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("npm", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe("CYBERVINCI_NPM_PACKAGE is required for package-manager updates.")
      }),
    )

    const commands: Array<[string, readonly string[]]> = []
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          commands.push([cmd, args])
          if (cmd === "npm") return { code: 1, stderr: "token=secret command output" }
          return ""
        },
      ),
    ).effect("uses an explicit package target and sanitizes command failures", () =>
      Effect.gen(function* () {
        process.env.CYBERVINCI_NPM_PACKAGE = "@owner/cybervinci"
        const error = yield* Effect.flip(Installation.use.upgrade("npm", "9.9.9"))
        expect(commands).toContainEqual(["npm", ["install", "-g", "@owner/cybervinci@9.9.9"]])
        expect(error.stderr).toBe("Upgrade failed for npm (exit code 1).")
        expect(error.stderr).not.toContain("secret")
      }),
    )

    testEffect(testLayer(() => new Response("installer", { status: 200 }))).effect(
      "requires an explicit installer URL",
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Installation.use.upgrade("curl", "9.9.9"))
          expect(error.stderr).toBe("CYBERVINCI_INSTALL_SCRIPT_URL is required for installer-based updates.")
        }),
    )

    testEffect(
      testLayer(
        () => new Response("install script", { status: 200 }),
        (cmd, args) => {
          if (cmd === "bash" && args[0] === "--version") return { code: 1, stderr: "missing" }
          if (cmd === "bash") return { code: 1, stderr: "should not run bash" }
          if (cmd === "sh") return "ok"
          return ""
        },
      ),
    ).effect("runs an explicitly configured installer and falls back to sh", () =>
      Effect.gen(function* () {
        process.env.CYBERVINCI_INSTALL_SCRIPT_URL = "https://installer.example.test/cybervinci"
        yield* Installation.use.upgrade("curl", "9.9.9")
      }),
    )
  })
})
