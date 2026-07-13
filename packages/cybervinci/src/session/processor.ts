import { LayerNode } from "@cybervinci-ai/core/effect/layer-node"
import { PermissionV1 } from "@cybervinci-ai/core/v1/permission"
import { Image } from "@/image/image"
import { SessionV1 } from "@cybervinci-ai/core/v1/session"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Context, Scope, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@cybervinci-ai/core/database/database"
import { Usage, type LLMEvent } from "@cybervinci-ai/llm"
import { McpDeadline } from "@/mcp/deadline"
import { KeyedMutex } from "@cybervinci-ai/core/effect/keyed-mutex"

const DOOM_LOOP_THRESHOLD = 3
const DEFAULT_PROVIDER_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_SESSION_CYCLE_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_TERMINAL_PERSIST_TIMEOUT_MS = 1_000
const DEFAULT_CLEANUP_TIMEOUT_MS = 15_000

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function sessionDeadlinePolicy(env: NodeJS.ProcessEnv = process.env) {
  return {
    providerIdleMs: positiveInteger(env.CYBERVINCI_PROVIDER_IDLE_TIMEOUT_MS, DEFAULT_PROVIDER_IDLE_TIMEOUT_MS),
    cycleMaximumMs: positiveInteger(env.CYBERVINCI_SESSION_CYCLE_TIMEOUT_MS, DEFAULT_SESSION_CYCLE_TIMEOUT_MS),
    terminalPersistMs: positiveInteger(
      env.CYBERVINCI_TERMINAL_PERSIST_TIMEOUT_MS,
      DEFAULT_TERMINAL_PERSIST_TIMEOUT_MS,
    ),
    cleanupMs: positiveInteger(env.CYBERVINCI_CLEANUP_TIMEOUT_MS, DEFAULT_CLEANUP_TIMEOUT_MS),
  }
}

export class SessionDeadlineError extends Error {
  override readonly name = "CyberVinciSessionDeadlineError"

  constructor(
    readonly reason: "provider_idle" | "cycle_timeout" | "cleanup_timeout",
    readonly deadlineMs: number,
  ) {
    super("CYBERVINCI session " + reason.replaceAll("_", " ") + " deadline exceeded after " + deadlineMs + "ms")
  }
}

export class TerminalPersistTimeout extends Error {
  override readonly name = "CyberVinciTerminalPersistTimeout"

  constructor(
    readonly toolCallID: string,
    readonly deadlineMs: number,
  ) {
    super("Persisting terminal state for " + toolCallID + " exceeded " + deadlineMs + "ms")
  }
}
export type Result = "compact" | "stop" | "continue"

export type ToolOutput = {
  title: string
  metadata: Record<string, any>
  output: string
  attachments?: SessionV1.FilePart[]
}

export interface Handle {
  readonly message: SessionV1.Assistant
  readonly startToolCall: (
    toolCallID: string,
    name: string,
    input: Record<string, unknown>,
  ) => Effect.Effect<void>
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
  ) => Effect.Effect<SessionV1.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: ToolOutput,
  ) => Effect.Effect<void>
  readonly failToolCall: (
    toolCallID: string,
    error: unknown,
    metadata?: Record<string, unknown>,
  ) => Effect.Effect<boolean>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
}

type Input = {
  assistantMessage: SessionV1.Assistant
  sessionID: SessionID
  model: Provider.Model
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolTerminal =
  | { readonly _tag: "Completed"; readonly output: ToolOutput }
  | {
      readonly _tag: "Failed"
      readonly error: unknown
      readonly metadata: Record<string, unknown>
    }

type ToolCall = {
  partID: SessionV1.ToolPart["id"]
  messageID: SessionV1.ToolPart["messageID"]
  sessionID: SessionV1.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
  terminal?: ToolTerminal
  commitInFlight: boolean
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  settledToolcalls: Set<string>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  currentText: SessionV1.TextPart | undefined
  reasoningMap: Record<string, SessionV1.ReasoningPart>
  closed: boolean
}

type StreamEvent = LLMEvent

export class Service extends Context.Service<Service, Interface>()("@cybervinci/SessionProcessor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const image = yield* Image.Service
    const events = yield* EventV2Bridge.Service
    const database = yield* Database.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        settledToolcalls: new Set(),
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        currentText: undefined,
        reasoningMap: {},
        closed: false,
      }
      let aborted = false
      let cleanupError: unknown
      const deadlines = sessionDeadlinePolicy()
      const toolCallLock = KeyedMutex.makeUnsafe<string>()

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (call) ctx.settledToolcalls.add(toolCallID)
        delete ctx.toolcalls[toolCallID]
        if (call) yield* Deferred.succeed(call.done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call || call.terminal) return undefined
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          yield* settleToolCall(toolCallID)
          return undefined
        }
        return { call, part }
      })

      const reliabilityMetadata = (error: unknown) =>
        error instanceof McpDeadline.DeadlineError
          ? {
              reliabilityReason: error.reason,
              deadlineMs: error.deadlineMs,
              elapsedMs: error.elapsedMs,
              ...(error.lastProgressAt === undefined ? {} : { lastProgressAt: error.lastProgressAt }),
            }
          : error instanceof SessionDeadlineError
            ? { reliabilityReason: error.reason, deadlineMs: error.deadlineMs }
            : {}

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
      ) {
        return yield* toolCallLock.withLock(toolCallID)(
          Effect.gen(function* () {
            if (ctx.closed) return undefined
            const match = yield* readToolCall(toolCallID)
            if (!match) return undefined
            const part = yield* session.updatePart(update(match.part))
            ctx.toolcalls[toolCallID] = {
              ...match.call,
              partID: part.id,
              messageID: part.messageID,
              sessionID: part.sessionID,
            }
            return part
          }),
        )
      })

      const commitTerminal = Effect.fn("SessionProcessor.commitTerminal")(function* (
        toolCallID: string,
        candidate: ToolTerminal,
        options: { allowClaimWhenClosed?: boolean } = {},
      ) {
        const attempt = yield* toolCallLock.withLock(toolCallID)(
          Effect.sync(() => {
            const call = ctx.toolcalls[toolCallID]
            if (!call) return undefined
            if (!call.terminal) {
              if (ctx.closed && !options.allowClaimWhenClosed) return undefined
              call.terminal = candidate
              if (
                candidate._tag === "Failed" &&
                (candidate.error instanceof PermissionV1.RejectedError ||
                  candidate.error instanceof Question.RejectedError)
              ) {
                ctx.blocked = ctx.shouldBreak
              }
            }
            if (call.commitInFlight) return undefined
            call.commitInFlight = true
            return {
              call,
              terminal: call.terminal,
              ids: {
                partID: call.partID,
                messageID: call.messageID,
                sessionID: call.sessionID,
              },
            }
          }),
        )
        if (!attempt) return false

        const worker = yield* Effect.gen(function* () {
          const part = yield* session.getPart(attempt.ids)
          if (!part || part.type !== "tool") {
            return yield* Effect.fail(new Error("Missing tool part for " + toolCallID))
          }
          if (part.state.status !== "running" && part.state.status !== "pending") return part
          const end = Date.now()
          const start = "time" in part.state ? part.state.time.start : end
          const next: SessionV1.ToolPart =
            attempt.terminal._tag === "Completed"
              ? {
                  ...part,
                  state: {
                    status: "completed",
                    input: part.state.input,
                    output: attempt.terminal.output.output,
                    metadata: attempt.terminal.output.metadata,
                    title: attempt.terminal.output.title,
                    time: { start, end },
                    attachments: attempt.terminal.output.attachments,
                  },
                }
              : {
                  ...part,
                  state: {
                    status: "error",
                    input: part.state.input,
                    error: errorMessage(attempt.terminal.error),
                    metadata: {
                      ...("metadata" in part.state ? part.state.metadata : {}),
                      ...attempt.terminal.metadata,
                      ...reliabilityMetadata(attempt.terminal.error),
                    },
                    time: { start, end },
                  },
                }
          return yield* session.updatePart(next)
        }).pipe(Effect.forkDetach({ startImmediately: true }))

        const exit = yield* Fiber.await(worker).pipe(
          Effect.timeoutOrElse({
            duration: deadlines.terminalPersistMs,
            orElse: () =>
              Effect.gen(function* () {
                yield* Effect.sleep("1 millis").pipe(
                  Effect.andThen(Effect.sync(() => worker.interruptUnsafe())),
                  Effect.forkDetach({ startImmediately: true }),
                )
                return Exit.fail(new TerminalPersistTimeout(toolCallID, deadlines.terminalPersistMs))
              }),
          }),
        )

        return yield* toolCallLock.withLock(toolCallID)(
          Effect.gen(function* () {
            const current = ctx.toolcalls[toolCallID]
            if (current !== attempt.call) return false
            current.commitInFlight = false
            if (Exit.isFailure(exit)) {
              yield* Effect.logError("failed to persist tool terminal state", {
                toolCallID,
                cause: Cause.pretty(exit.cause),
              })
              return false
            }
            yield* settleToolCall(toolCallID)
            return true
          }),
        )
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: ToolOutput,
      ) {
        yield* commitTerminal(toolCallID, { _tag: "Completed", output })
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (
        toolCallID: string,
        error: unknown,
        metadata: Record<string, unknown> = {},
        options: { allowClaimWhenClosed?: boolean } = {},
      ) {
        return yield* commitTerminal(toolCallID, { _tag: "Failed", error, metadata }, options)
      })

      const finishReasoning = Effect.fn("SessionProcessor.finishReasoning")(function* (reasoningID: string) {
        if (!(reasoningID in ctx.reasoningMap)) return
        // oxlint-disable-next-line no-self-assign -- reactivity trigger
        ctx.reasoningMap[reasoningID].text = ctx.reasoningMap[reasoningID].text
        ctx.reasoningMap[reasoningID].time = { ...ctx.reasoningMap[reasoningID].time, end: Date.now() }
        yield* session.updatePart(ctx.reasoningMap[reasoningID])
        delete ctx.reasoningMap[reasoningID]
      })

      const ensureToolCall = Effect.fn("SessionProcessor.ensureToolCall")(function* (input: {
        id: string
        name: string
        providerExecuted?: boolean
      }) {
        return yield* toolCallLock.withLock(input.id)(
          Effect.gen(function* () {
            if (ctx.closed || ctx.settledToolcalls.has(input.id)) return undefined
            if (ctx.toolcalls[input.id]?.terminal) return undefined
            const existing = yield* readToolCall(input.id)
            if (existing) {
              if (!input.providerExecuted || existing.part.metadata?.providerExecuted) return existing
              const part = yield* session.updatePart({
                ...existing.part,
                metadata: { ...existing.part.metadata, providerExecuted: true },
              })
              ctx.toolcalls[input.id] = {
                ...existing.call,
                partID: part.id,
                messageID: part.messageID,
                sessionID: part.sessionID,
              }
              return { call: ctx.toolcalls[input.id], part }
            }
            const part = yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "tool",
              tool: input.name,
              callID: input.id,
              state: { status: "pending", input: {}, raw: "" },
              metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
            } satisfies SessionV1.ToolPart)
            if (ctx.closed) {
              const end = Date.now()
              yield* session.updatePart({
                ...part,
                state: {
                  status: "error",
                  input: part.state.input,
                  error: "Tool result arrived after the session cycle closed",
                  metadata: { reliabilityReason: "late_registration" },
                  time: { start: end, end },
                },
              })
              return undefined
            }
            ctx.toolcalls[input.id] = {
              done: yield* Deferred.make<void>(),
              commitInFlight: false,
              partID: part.id,
              messageID: part.messageID,
              sessionID: part.sessionID,
            }
            return { call: ctx.toolcalls[input.id], part }
          }),
        )
      })

      const startToolCall = Effect.fn("SessionProcessor.startToolCall")(function* (
        toolCallID: string,
        name: string,
        input: Record<string, unknown>,
      ) {
        if (!(yield* ensureToolCall({ id: toolCallID, name }))) return
        yield* updateToolCall(toolCallID, (part) => ({
          ...part,
          tool: name,
          state:
            part.state.status === "running"
              ? { ...part.state, input }
              : {
                  status: "running",
                  input,
                  time: { start: Date.now() },
                },
        }))
      })

      const isFilePart = (value: unknown): value is SessionV1.FilePart => Schema.is(SessionV1.FilePart)(value)

      const toolResultOutput = (
        value: Extract<StreamEvent, { type: "tool-result" }>,
      ): { title: string; metadata: Record<string, any>; output: string; attachments?: SessionV1.FilePart[] } => {
        if (isRecord(value.result.value) && typeof value.result.value.output === "string") {
          return {
            title: typeof value.result.value.title === "string" ? value.result.value.title : value.name,
            metadata: isRecord(value.result.value.metadata) ? value.result.value.metadata : {},
            output: value.result.value.output,
            attachments: Array.isArray(value.result.value.attachments)
              ? value.result.value.attachments.filter(isFilePart)
              : undefined,
          }
        }
        return {
          title: value.name,
          metadata: value.result.type === "json" && isRecord(value.result.value) ? value.result.value : {},
          output:
            typeof value.result.value === "string" ? value.result.value : (JSON.stringify(value.result.value) ?? ""),
        }
      }

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        if (ctx.closed) return
        switch (value.type) {
          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.reasoningMap[value.id])
            return

          case "reasoning-delta":
            // Match dev: silently drop orphan deltas (no preceding reasoning-start).
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            if (value.providerMetadata && value.id in ctx.reasoningMap) {
              ctx.reasoningMap[value.id].metadata = value.providerMetadata
            }
            yield* finishReasoning(value.id)
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            return

          case "tool-input-delta":
            yield* ensureToolCall(value)
            return

          case "tool-input-end": {
            yield* ensureToolCall(value)
            return
          }

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            const input = isRecord(value.input) ? value.input : { value: value.input }
            yield* updateToolCall(value.id, (match) => ({
              ...match,
              tool: value.name,
              state:
                match.state.status === "running"
                  ? { ...match.state, input }
                  : {
                      status: "running",
                      input,
                      time: { start: Date.now() },
                    },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            const parts = yield* MessageV2.parts(ctx.assistantMessage.id).pipe(
              Effect.provideService(Database.Service, database),
            )
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.name &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(input),
              )
            ) {
              return
            }

            const agent = yield* agents.get(ctx.assistantMessage.agent)
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.name],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.name, input },
              always: [value.name],
              ruleset: agent.permission,
            })
            return
          }

          case "tool-result": {
            const toolCall = yield* readToolCall(value.id)
            if (!toolCall && value.result.type === "error") return
            if (value.result.type === "error") {
              yield* failToolCall(value.id, value.result.value)
              return
            }
            const rawOutput = toolResultOutput(value)
            const normalized = yield* Effect.forEach(rawOutput.attachments ?? [], (attachment) =>
              attachment.mime.startsWith("image/")
                ? image.normalize(attachment).pipe(
                    Effect.catchIf(
                      (error) => error instanceof Image.ResizerUnavailableError,
                      () => Effect.succeed(attachment),
                    ),
                    Effect.exit,
                  )
                : Effect.succeed(Exit.succeed<SessionV1.FilePart>(attachment)),
            )
            const omitted = normalized.filter(Exit.isFailure).length
            const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
            const output = {
              ...rawOutput,
              output:
                omitted === 0
                  ? rawOutput.output
                  : `${rawOutput.output}\n\n[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be resized below the image size limit.]`,
              attachments: attachments.length ? attachments : undefined,
            }
            yield* completeToolCall(value.id, output)
            return
          }

          case "tool-error": {
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            return
          }

          case "provider-error":
            throw new Error(value.message)

          case "step-start":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "step-finish": {
            const completedSnapshot = yield* snapshot.track()
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
            })
            ctx.assistantMessage.finish = value.reason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.reason,
              snapshot: completedSnapshot,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            if (ctx.snapshot) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta":
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            return

          case "text-end":
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
            return

          case "finish":
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        if (ctx.snapshot) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )

        const terminalError = cleanupError instanceof SessionDeadlineError ? cleanupError : new Error("Tool execution aborted")
        yield* Effect.forEach(
          Object.keys(ctx.toolcalls),
          (toolCallID) =>
            failToolCall(
              toolCallID,
              terminalError,
              aborted ? { interrupted: true } : {},
              { allowClaimWhenClosed: true },
            ),
          { concurrency: "unbounded" },
        )
        if (Object.keys(ctx.toolcalls).length) {
          yield* Effect.logError("tool terminal state remained uncommitted after cleanup", {
            toolCallIDs: Object.keys(ctx.toolcalls),
          })
        }
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        yield* Effect.logError("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
          error: errorMessage(e),
          stack: e instanceof Error ? e.stack : undefined,
        })
        const error = parse(e)
        if (SessionV1.ContextOverflowError.isInstance(error)) {
          if ((yield* config.get()).compaction?.auto === false && !ctx.assistantMessage.summary) {
            ctx.assistantMessage.error = error
            ctx.assistantMessage.finish = "error"
            yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            yield* status.set(ctx.sessionID, { type: "idle" })
            return
          }
          ctx.needsCompaction = true
          yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        ctx.assistantMessage.error = error
        yield* events.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        yield* Effect.logInfo("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
        })
        ctx.needsCompaction = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

        return yield* Effect.gen(function* () {
          const runStream = Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            yield* status.set(ctx.sessionID, { type: "busy" })
            yield* llm.stream(streamInput).pipe(
              Stream.tap((event) => handleEvent(event)),
              Stream.takeUntil(() => ctx.needsCompaction),
              Stream.timeoutOrElse({
                duration: deadlines.providerIdleMs,
                orElse: () => Stream.fail(new SessionDeadlineError("provider_idle", deadlines.providerIdleMs)),
              }),
              Stream.runDrain,
            )
          }).pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.retry(
              SessionRetry.policy({
                provider: input.model.providerID,
                parse,
                set: (info) => {
                  return status.set(ctx.sessionID, {
                    type: "retry",
                    attempt: info.attempt,
                    message: info.message,
                    action: info.action,
                    next: info.next,
                  })
                },
              }),
            ),
          )

          const worker = yield* runStream.pipe(Effect.forkDetach({ startImmediately: true }))
          const cleanupGuarded = Effect.gen(function* () {
            ctx.closed = true
            const cleanupWorker = yield* cleanup().pipe(Effect.forkDetach({ startImmediately: true }))
            yield* Fiber.join(cleanupWorker).pipe(
              Effect.timeoutOrElse({
                duration: deadlines.cleanupMs,
                orElse: () =>
                  Effect.gen(function* () {
                    yield* Effect.sleep("1 millis").pipe(
                      Effect.andThen(Effect.sync(() => cleanupWorker.interruptUnsafe())),
                      Effect.forkDetach({ startImmediately: true }),
                    )
                    yield* Effect.logError("session cleanup deadline exceeded", {
                      sessionID: ctx.sessionID,
                      deadlineMs: deadlines.cleanupMs,
                    })
                    yield* status.set(ctx.sessionID, { type: "idle" })
                  }),
              }),
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  yield* Effect.logError("session cleanup failed", { cause: Cause.pretty(cause) })
                  yield* status.set(ctx.sessionID, { type: "idle" })
                }),
              ),
            )
          })

          yield* Fiber.join(worker).pipe(
            Effect.timeoutOrElse({
              duration: deadlines.cycleMaximumMs,
              orElse: () =>
                Effect.gen(function* () {
                  yield* Effect.sleep("1 millis").pipe(
                    Effect.andThen(Effect.sync(() => worker.interruptUnsafe())),
                    Effect.forkDetach({ startImmediately: true }),
                  )
                  return yield* Effect.fail(
                    new SessionDeadlineError("cycle_timeout", deadlines.cycleMaximumMs),
                  )
                }),
            }),
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                worker.interruptUnsafe()
                aborted = true
                const error = new DOMException("Aborted", "AbortError")
                cleanupError = error
                if (!ctx.assistantMessage.error) yield* halt(error)
              }),
            ),
            Effect.catch((error) => {
              cleanupError = error
              return halt(error)
            }),
            Effect.ensuring(cleanupGuarded),
          )
          if (ctx.needsCompaction) return "compact"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        startToolCall,
        updateToolCall,
        completeToolCall,
        failToolCall,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Session.node,
    Config.node,
    Snapshot.node,
    Agent.node,
    LLM.node,
    Permission.node,
    Plugin.node,
    SessionSummary.node,
    SessionStatus.node,
    Image.node,
    EventV2Bridge.node,
    Database.node,
  ],
})

export * as SessionProcessor from "./processor"
