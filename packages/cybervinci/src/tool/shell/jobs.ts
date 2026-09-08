import { Cause, Context, Deferred, Effect, Exit, Layer, Scope } from "effect"
import { LayerNode } from "@cybervinci-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import type { Tool } from "../tool"

type Result = Tool.ExecuteResult<Record<string, unknown>>
type Status = "running" | "stopping" | "completed" | "timed_out" | "cancelled" | "error" | "termination_unconfirmed"

export type Info = {
  id: string
  command: string
  status: Status
  startedAt: number
  completedAt?: number
  metadata: Record<string, unknown>
  output: string
}

type Entry = {
  owner: string
  callID?: string
  abort: AbortController
  done: Deferred.Deferred<void>
  info: Info
}

export interface Interface {
  start(
    command: string,
    ctx: Tool.Context,
    run: (ctx: Tool.Context) => Effect.Effect<Result, unknown>,
  ): Effect.Effect<Info>
  list(owner: string): Effect.Effect<Info[]>
  get(owner: string, id: string): Effect.Effect<Info | undefined>
  wait(owner: string, id: string, timeout: number): Effect.Effect<Info | undefined>
  cancel(owner: string, id: string): Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@cybervinci/ShellJobs") {}

const active = (entry: Entry) => entry.info.status === "running" || entry.info.status === "stopping"
const unresolved = (entry: Entry) => active(entry) || entry.info.status === "termination_unconfirmed"
const snapshot = (entry: Entry): Info => ({ ...entry.info, metadata: { ...entry.info.metadata } })
const interrupted = (entry: Entry) => {
  // Missing progress/PID data is not proof that launch never happened.
  entry.info.status = "termination_unconfirmed"
  entry.info.completedAt = Date.now()
  entry.info.metadata = { ...entry.info.metadata, terminationConfirmed: false }
  entry.info.output += "\nTermination acknowledgement unavailable after owner shutdown. Do not rerun automatically."
}

/** Process-local, instance- and session-owned commands. Never replay on restart. */
export const make = Effect.gen(function* () {
  const scope = yield* Scope.Scope
  const entries = new Map<string, Entry>()
  let closed = false
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true
      // Child-fiber finalizers normally settle entries first. Also cover an
      // admitted fiber that was interrupted before its execution started.
      for (const entry of entries.values()) {
        if (!active(entry)) continue
        entry.abort.abort()
        interrupted(entry)
        yield* Deferred.succeed(entry.done, undefined)
      }
    }),
  )
  const owned = (owner: string, id: string) => {
    const entry = entries.get(id)
    return entry?.owner === owner ? entry : undefined
  }

  const start: Interface["start"] = Effect.fn("ShellJobs.start")(function* (command, ctx, run) {
    if (closed) return yield* Effect.die(new Error("Shell job owner has shut down"))
    if (ctx.abort.aborted) return yield* Effect.die(new Error("Command cancelled before launch"))
    if (ctx.callID) {
      const previous = [...entries.values()].find(
        (entry) => entry.owner === ctx.sessionID && entry.callID === ctx.callID,
      )
      if (previous) {
        if (previous.info.command !== command) return yield* Effect.die(new Error("Conflicting shell call ID"))
        return snapshot(previous)
      }
    }
    if ([...entries.values()].filter(unresolved).length >= 32)
      return yield* Effect.die(
        new Error("Too many running shell jobs. Inspect or finish an existing job before launching another."),
      )
    // Bound retained results, without evicting or terminating live work.
    for (const [id, entry] of entries) {
      if (entries.size < 128) break
      if (!unresolved(entry)) entries.delete(id)
    }
    const entry: Entry = {
      owner: ctx.sessionID,
      callID: ctx.callID,
      abort: new AbortController(),
      done: yield* Deferred.make<void>(),
      info: { id: crypto.randomUUID(), command, status: "running", startedAt: Date.now(), metadata: {}, output: "" },
    }
    entries.set(entry.info.id, entry)
    yield* run({
      ...ctx,
      abort: entry.abort.signal,
      // The originating tool result is immutable after launch. Progress belongs
      // to the job, not to a tool part that has already been finalized.
      metadata: (update) =>
        Effect.sync(() => {
          if (!active(entry)) return
          entry.info.metadata = { ...entry.info.metadata, ...update.metadata }
          if (typeof update.metadata?.output === "string") entry.info.output = update.metadata.output
        }),
    }).pipe(
      Effect.interruptible,
      // Unlike an ordinary error handler, onExit runs during scope interruption.
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (!active(entry)) return
          if (Exit.isSuccess(exit)) {
            const result = exit.value
            const status = result.metadata.status
            entry.info = {
              ...entry.info,
              status:
                status === "timed_out" ||
                status === "cancelled" ||
                status === "termination_unconfirmed" ||
                status === "error"
                  ? status
                  : "completed",
              completedAt: Date.now(),
              metadata: result.metadata,
              output: result.output,
            }
          } else {
            const cause = exit.cause
            // Owner-scope interruption bypasses the shell's returned result.
            // Do not turn the absence of a termination acknowledgement into
            // a claim that a spawned OS process was successfully cancelled.
            if (Cause.hasInterruptsOnly(cause)) interrupted(entry)
            else {
              entry.info.status = "error"
              entry.info.completedAt = Date.now()
            }
            entry.info.output += `\n${String(Cause.squash(cause))}`
          }
        }),
      ),
      Effect.ensuring(Deferred.succeed(entry.done, undefined)),
      Effect.catchCause(() => Effect.void),
      Effect.forkIn(scope, { startImmediately: true }),
    )
    return snapshot(entry)
  }, Effect.uninterruptible)

  const list: Interface["list"] = (owner) =>
    Effect.sync(() => [...entries.values()].filter((entry) => entry.owner === owner).map(snapshot))
  const get: Interface["get"] = (owner, id) =>
    Effect.sync(() => {
      const entry = owned(owner, id)
      return entry ? snapshot(entry) : undefined
    })
  const wait: Interface["wait"] = Effect.fn("ShellJobs.wait")(function* (owner, id, timeout) {
    const entry = owned(owner, id)
    if (!entry) return
    if (active(entry))
      yield* Deferred.await(entry.done).pipe(Effect.timeoutOption(Math.max(0, Math.min(30_000, timeout))))
    return snapshot(entry)
  })
  const cancel: Interface["cancel"] = Effect.fn("ShellJobs.cancel")(function* (owner, id) {
    const entry = owned(owner, id)
    if (!entry) return
    if (active(entry)) {
      entry.info.status = "stopping"
      entry.abort.abort()
    }
    // A request to stop is not proof that the OS process has stopped.
    return yield* wait(owner, id, 8_000)
  })
  return Service.of({ start, list, get, wait, cancel })
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(() => make)
    return Service.of({
      start: (...args) => InstanceState.useEffect(state, (jobs) => jobs.start(...args)),
      list: (...args) => InstanceState.useEffect(state, (jobs) => jobs.list(...args)),
      get: (...args) => InstanceState.useEffect(state, (jobs) => jobs.get(...args)),
      wait: (...args) => InstanceState.useEffect(state, (jobs) => jobs.wait(...args)),
      cancel: (...args) => InstanceState.useEffect(state, (jobs) => jobs.cancel(...args)),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })
export * as ShellJobs from "./jobs"
