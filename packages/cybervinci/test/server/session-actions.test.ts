import { afterEach, describe, expect, mock } from "bun:test"
import { LayerNode } from "@cybervinci-ai/core/effect/layer-node"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID } from "@/session/schema"
import { ProviderV2 } from "@cybervinci-ai/core/provider"
import { ModelV2 } from "@cybervinci-ai/core/model"
import { Session as SessionNs } from "@/session/session"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([SessionNs.node, SessionRunState.node])), httpApiLayer),
)

afterEach(async () => {
  mock.restore()
  await disposeAllInstances()
})

describe("session action routes", () => {
  it.instance("destructive routes reject an active writer without changing its history", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const state = yield* SessionRunState.Service
      const chat = yield* session.create({})
      const info = yield* session.updateMessage({
        id: MessageID.ascending(),
        sessionID: chat.id,
        role: "user",
        agent: "default",
        time: { created: Date.now() },
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      })
      const part = yield* session.updatePart({
        id: PartID.ascending(),
        messageID: info.id,
        sessionID: chat.id,
        type: "text",
        text: "keep this history",
      })
      yield* session.setRevert({ sessionID: chat.id, revert: { messageID: info.id }, summary: undefined })
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const work = yield* state
        .ensureRunning(
          chat.id,
          Effect.succeed({ info, parts: [part] }),
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ info, parts: [part] }),
          ),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const statuses = yield* Effect.gen(function* () {
        const summarize = yield* requestInDirectory(`/session/${chat.id}/summarize`, test.directory, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerID: "test", modelID: "test" }),
        })
        const message = yield* requestInDirectory(`/session/${chat.id}/message/${info.id}`, test.directory, {
          method: "DELETE",
        })
        const removedPart = yield* requestInDirectory(
          `/session/${chat.id}/message/${info.id}/part/${part.id}`,
          test.directory,
          { method: "DELETE" },
        )
        return [summarize.status, message.status, removedPart.status]
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
      yield* Fiber.join(work)
      expect(statuses).toEqual([400, 409, 400])
      const messages = yield* session.messages({ sessionID: chat.id })
      expect(messages.map((message) => message.info.id)).toEqual([info.id])
      expect(messages[0].parts).toHaveLength(1)
    }),
  )

  it.instance(
    "session routes expose metadata on create, update, get, and fork",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "Content-Type": "application/json" }

        const created = yield* requestInDirectory("/session", test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "meta-session",
            metadata: { source: "sdk", trace: { id: "abc" } },
          }),
        })
        expect(created.status).toBe(200)

        const session = (yield* created.json) as SessionNs.Info
        expect(session.metadata).toEqual({ source: "sdk", trace: { id: "abc" } })

        const updated = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadata: { source: "sdk", trace: { id: "def" }, tags: ["one"] } }),
        })
        expect(updated.status).toBe(200)

        const next = (yield* updated.json) as SessionNs.Info
        expect(next.metadata).toEqual({ source: "sdk", trace: { id: "def" }, tags: ["one"] })

        const fetched = yield* requestInDirectory(`/session/${session.id}`, test.directory)
        expect(fetched.status).toBe(200)
        expect(((yield* fetched.json) as SessionNs.Info).metadata).toEqual(next.metadata)

        const forked = yield* requestInDirectory(`/session/${session.id}/fork`, test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(forked.status).toBe(200)

        const fork = (yield* forked.json) as SessionNs.Info
        expect(fork.metadata).toEqual(next.metadata)

        const reset = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadata: {} }),
        })
        expect(reset.status).toBe(200)
        expect(((yield* reset.json) as SessionNs.Info).metadata).toEqual({})

        yield* SessionNs.Service.use((svc) => svc.remove(fork.id).pipe(Effect.ignore))
        yield* SessionNs.Service.use((svc) => svc.remove(session.id).pipe(Effect.ignore))
      }),
    { git: true },
  )

  it.instance(
    "abort route returns success",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* requestInDirectory(`/session/${session.id}/abort`, test.directory, { method: "POST" })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "experimental background route is a no-op without synchronous subagents",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* requestInDirectory(`/experimental/session/${session.id}/background`, test.directory, {
          method: "POST",
        })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(false)
      }),
    { git: true },
  )
})
