import { expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { ShellJobs } from "@/tool/shell/jobs"
import { SessionID, MessageID } from "@/session/schema"
import type { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"
import { Layer } from "effect"

const it = testEffect(Layer.empty)
const context = (callID = crypto.randomUUID()): Tool.Context => ({
  sessionID: SessionID.make("ses_shell_jobs"),
  messageID: MessageID.make("msg_shell_jobs"),
  agent: "build",
  callID,
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.die(new Error("Must not update a finalized launch tool")),
  ask: () => Effect.void,
})
const result = (status = "completed") => ({ title: "test", metadata: { status }, output: "retained result" })

it.live("owner shutdown does not fabricate a termination acknowledgement", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const jobs = yield* ShellJobs.make.pipe(Scope.provide(scope))
    const ctx = context()
    const started = yield* Deferred.make<void>()
    const job = yield* jobs.start("test", ctx, (next) =>
      Effect.gen(function* () {
        yield* next.metadata({ metadata: { pid: 12345 } })
        yield* Deferred.succeed(started, undefined)
        return yield* Effect.never
      }),
    )
    yield* Deferred.await(started)
    yield* Scope.close(scope, Exit.void)
    expect(yield* jobs.get(ctx.sessionID, job.id)).toMatchObject({ status: "termination_unconfirmed" })
    expect(yield* jobs.wait(ctx.sessionID, job.id, 1000)).toMatchObject({ status: "termination_unconfirmed" })
    expect(
      yield* jobs.start("after shutdown", context(), () => Effect.succeed(result())).pipe(Effect.exit),
    ).toMatchObject({ _tag: "Failure" })
  }),
)

it.live("shell jobs return promptly, retain progress, and deliver the terminal result", () =>
  Effect.gen(function* () {
    const jobs = yield* ShellJobs.make
    const release = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    const ctx = context()
    const job = yield* jobs.start("test", ctx, (next) =>
      Effect.gen(function* () {
        yield* next.metadata({ metadata: { output: "progress" } })
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        return result()
      }),
    )
    yield* Deferred.await(started)
    expect(yield* jobs.get(ctx.sessionID, job.id)).toMatchObject({ status: "running", output: "progress" })
    expect(yield* jobs.wait(ctx.sessionID, job.id, 0)).toMatchObject({ status: "running" })
    yield* Deferred.succeed(release, undefined)
    expect(yield* jobs.wait(ctx.sessionID, job.id, 1000)).toMatchObject({
      status: "completed",
      output: "retained result",
    })
  }),
)

it.live("shell jobs isolate owners and deduplicate exact tool-call retries", () =>
  Effect.gen(function* () {
    const jobs = yield* ShellJobs.make
    const ctx = context()
    const release = yield* Deferred.make<void>()
    let executions = 0
    const run = () =>
      Effect.gen(function* () {
        executions++
        yield* Deferred.await(release)
        return result()
      })
    const first = yield* jobs.start("test", ctx, run)
    const second = yield* jobs.start("test", ctx, run)
    expect(second.id).toBe(first.id)
    expect(yield* jobs.get("another-session", first.id)).toBeUndefined()
    expect(yield* jobs.cancel("another-session", first.id)).toBeUndefined()
    expect(yield* jobs.wait("another-session", first.id, 10)).toBeUndefined()
    yield* Deferred.succeed(release, undefined)
    yield* jobs.wait(ctx.sessionID, first.id, 1000)
    expect(executions).toBe(1)
    const duplicate = yield* jobs.start("test", ctx, run)
    expect(duplicate.id).toBe(first.id)
    expect(executions).toBe(1)
  }),
)

it.live("shell cancellation reports stopping until execution acknowledges termination", () =>
  Effect.gen(function* () {
    const jobs = yield* ShellJobs.make
    const ctx = context()
    const requested = yield* Deferred.make<void>()
    const finished = yield* Deferred.make<void>()
    const job = yield* jobs.start("test", ctx, (next) =>
      Effect.gen(function* () {
        yield* Effect.callback<void>((resume) => {
          const stop = () => resume(Effect.void)
          if (next.abort.aborted) stop()
          else next.abort.addEventListener("abort", stop, { once: true })
          return Effect.sync(() => next.abort.removeEventListener("abort", stop))
        })
        yield* Deferred.succeed(requested, undefined)
        yield* Deferred.await(finished)
        return result("cancelled")
      }),
    )
    const cancel = yield* jobs.cancel(ctx.sessionID, job.id).pipe(Effect.forkChild)
    yield* Deferred.await(requested)
    expect(yield* jobs.get(ctx.sessionID, job.id)).toMatchObject({ status: "stopping" })
    yield* Deferred.succeed(finished, undefined)
    expect(yield* Fiber.join(cancel)).toMatchObject({ status: "cancelled" })
  }),
)

it.live("shell jobs preserve timeout and unconfirmed termination instead of claiming success", () =>
  Effect.gen(function* () {
    const jobs = yield* ShellJobs.make
    const ctx = context()
    for (const status of ["timed_out", "termination_unconfirmed"]) {
      const job = yield* jobs.start("test", { ...ctx, callID: crypto.randomUUID() }, () =>
        Effect.succeed(result(status)),
      )
      expect(yield* jobs.wait(ctx.sessionID, job.id, 1000)).toMatchObject({ status })
    }
    const job = yield* jobs.start("failure", { ...ctx, callID: crypto.randomUUID() }, () =>
      Effect.fail(new Error("test failure")),
    )
    expect(yield* jobs.wait(ctx.sessionID, job.id, 1000)).toMatchObject({ status: "error" })
  }),
)
