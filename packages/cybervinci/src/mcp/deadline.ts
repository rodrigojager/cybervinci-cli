export type ReliabilityMode = "off" | "observe" | "enforce"

export interface DeadlinePolicy {
  mode: ReliabilityMode
  maximumMs: number
  cancelGraceMs: number
}

export interface DeadlineClock {
  now: () => number
  schedule: (delayMs: number, callback: () => void) => () => void
}

export interface DeadlineEvent {
  reason: "maximum"
  deadlineMs: number
  elapsedMs: number
  lastProgressAt?: number
}

export interface CallInput<T> {
  call: (input: { signal: AbortSignal; onprogress: () => void }) => Promise<T>
  signal?: AbortSignal
  policy?: DeadlinePolicy
  clock?: DeadlineClock
  observe?: (event: DeadlineEvent) => void
}

export class DeadlineError extends Error {
  readonly reason: "timeout" | "cancelled"
  readonly deadlineMs: number
  readonly elapsedMs: number
  readonly lastProgressAt?: number

  constructor(input: {
    reason: "timeout" | "cancelled"
    deadlineMs: number
    elapsedMs: number
    lastProgressAt?: number
  }) {
    super(
      input.reason === "timeout"
        ? `CYBERVINCI MCP tool exceeded its ${input.deadlineMs}ms maximum deadline`
        : `CYBERVINCI MCP tool was cancelled (${input.deadlineMs}ms maximum grace)`,
    )
    this.name = "CyberVinciMcpDeadlineError"
    this.reason = input.reason
    this.deadlineMs = input.deadlineMs
    this.elapsedMs = input.elapsedMs
    this.lastProgressAt = input.lastProgressAt
  }
}

const DEFAULT_POLICY: DeadlinePolicy = {
  mode: "enforce",
  maximumMs: 12 * 60 * 60 * 1_000,
  cancelGraceMs: 2_000,
}

const liveClock: DeadlineClock = {
  now: Date.now,
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}

export function policy(env: Record<string, string | undefined> = process.env): DeadlinePolicy {
  const mode = env.CYBERVINCI_RELIABILITY_MODE
  return {
    mode: mode === "off" || mode === "observe" || mode === "enforce" ? mode : DEFAULT_POLICY.mode,
    maximumMs: positiveInteger(env.CYBERVINCI_MCP_MAX_TIMEOUT_MS, DEFAULT_POLICY.maximumMs),
    cancelGraceMs: positiveInteger(env.CYBERVINCI_CANCEL_GRACE_MS, DEFAULT_POLICY.cancelGraceMs),
  }
}

export function supervise<T>(input: CallInput<T>): Promise<T> {
  const settings = input.policy ?? policy()
  if (settings.mode === "off") {
    return input.call({ signal: input.signal ?? new AbortController().signal, onprogress: () => {} })
  }

  const clock = input.clock ?? liveClock
  const controller = new AbortController()
  const startedAt = clock.now()
  let lastProgressAt: number | undefined
  let settled = false
  let reason: DeadlineError["reason"] | undefined
  let cancelMaximum = () => {}
  let cancelGrace = () => {}

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      cancelMaximum()
      cancelGrace()
      input.signal?.removeEventListener("abort", cancel)
    }

    const settle = (result: { value: T } | { error: unknown }) => {
      if (settled) return
      settled = true
      cleanup()
      if ("value" in result) resolve(result.value)
      else reject(result.error)
    }

    const deadlineError = () =>
      new DeadlineError({
        reason: reason!,
        deadlineMs: reason === "timeout" ? settings.maximumMs : settings.cancelGraceMs,
        elapsedMs: clock.now() - startedAt,
        lastProgressAt,
      })

    const requestStop = (next: DeadlineError["reason"]) => {
      if (settled || reason) return
      reason = next
      cancelMaximum()
      controller.abort(next)
      cancelGrace = clock.schedule(settings.cancelGraceMs, () => settle({ error: deadlineError() }))
    }

    function cancel() {
      requestStop("cancelled")
    }

    if (input.signal?.aborted) {
      reason = "cancelled"
      settle({ error: deadlineError() })
      return
    }

    input.signal?.addEventListener("abort", cancel, { once: true })
    cancelMaximum = clock.schedule(settings.maximumMs, () => {
      const event = {
        reason: "maximum" as const,
        deadlineMs: settings.maximumMs,
        elapsedMs: clock.now() - startedAt,
        lastProgressAt,
      }
      try {
        ;(input.observe ?? ((item) => console.warn("CYBERVINCI observed an MCP maximum deadline", item)))(event)
      } catch (error) {
        console.warn("CYBERVINCI deadline observer failed", error)
      } finally {
        if (settings.mode === "enforce") requestStop("timeout")
      }
    })

    Promise.resolve()
      .then(() =>
        input.call({
          signal: controller.signal,
          onprogress: () => {
            lastProgressAt = clock.now()
          },
        }),
      )
      .then(
        (value) => settle({ value }),
        (error) => settle({ error: reason ? deadlineError() : error }),
      )
  })
}

function positiveInteger(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback
  return parsed
}

export * as McpDeadline from "./deadline"
