import { describe, expect, test } from "bun:test"
import { McpDeadline } from "@/mcp/deadline"

class ManualClock implements McpDeadline.DeadlineClock {
  private time = 0
  private sequence = 0
  private jobs = new Map<number, { at: number; callback: () => void }>()

  now = () => this.time

  schedule = (delayMs: number, callback: () => void) => {
    const id = this.sequence++
    this.jobs.set(id, { at: this.time + delayMs, callback })
    return () => this.jobs.delete(id)
  }

  advance(ms: number) {
    const target = this.time + ms
    while (true) {
      const next = [...this.jobs.entries()]
        .filter(([, job]) => job.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      if (!this.jobs.delete(next[0])) continue
      this.time = next[1].at
      next[1].callback()
    }
    this.time = target
  }
}

const settings = {
  mode: "enforce" as const,
  maximumMs: 100,
  cancelGraceMs: 10,
}

describe("McpDeadline.supervise", () => {
  test("releases a call that ignores maximum deadline cancellation", async () => {
    const clock = new ManualClock()
    let signal: AbortSignal | undefined
    const result = McpDeadline.supervise({
      clock,
      policy: settings,
      call: (input) => {
        signal = input.signal
        return new Promise(() => {})
      },
    })

    await Promise.resolve()
    clock.advance(100)
    expect(signal?.aborted).toBe(true)
    clock.advance(10)

    await expect(result).rejects.toMatchObject({
      name: "CyberVinciMcpDeadlineError",
      reason: "timeout",
      deadlineMs: 100,
    })
  })

  test("progress cannot renew the maximum deadline", async () => {
    const clock = new ManualClock()
    let progress = () => {}
    const result = McpDeadline.supervise({
      clock,
      policy: settings,
      call: (input) => {
        progress = input.onprogress
        return new Promise(() => {})
      },
    })

    await Promise.resolve()
    for (let index = 0; index < 4; index++) {
      clock.advance(25)
      progress()
    }
    clock.advance(10)

    await expect(result).rejects.toMatchObject({ reason: "timeout", lastProgressAt: 100 })
  })

  test("releases explicit cancellation when the remote call ignores its signal", async () => {
    const clock = new ManualClock()
    const controller = new AbortController()
    const result = McpDeadline.supervise({
      clock,
      policy: settings,
      signal: controller.signal,
      call: () => new Promise(() => {}),
    })

    await Promise.resolve()
    controller.abort()
    clock.advance(10)

    await expect(result).rejects.toMatchObject({ reason: "cancelled", deadlineMs: 10 })
  })

  test("keeps the first terminal outcome when a result arrives late", async () => {
    const clock = new ManualClock()
    let resolveRemote = (_value: string) => {}
    const result = McpDeadline.supervise({
      clock,
      policy: settings,
      call: () =>
        new Promise<string>((resolve) => {
          resolveRemote = resolve
        }),
    })

    await Promise.resolve()
    clock.advance(110)
    await expect(result).rejects.toMatchObject({ reason: "timeout" })
    resolveRemote("late")
    await Promise.resolve()
    await expect(result).rejects.toMatchObject({ reason: "timeout" })
  })

  test("observer failures cannot prevent enforcement", async () => {
    const clock = new ManualClock()
    const result = McpDeadline.supervise({
      clock,
      policy: settings,
      observe: () => {
        throw new Error("observer failed")
      },
      call: () => new Promise(() => {}),
    })

    await Promise.resolve()
    clock.advance(110)
    await expect(result).rejects.toMatchObject({ reason: "timeout" })
  })

  test("explicit cancellation removes the maximum timer", async () => {
    const clock = new ManualClock()
    const controller = new AbortController()
    const events: McpDeadline.DeadlineEvent[] = []
    const result = McpDeadline.supervise({
      clock,
      policy: settings,
      signal: controller.signal,
      observe: (event) => events.push(event),
      call: () => new Promise(() => {}),
    })

    await Promise.resolve()
    controller.abort()
    clock.advance(110)
    await expect(result).rejects.toMatchObject({ reason: "cancelled" })
    expect(events).toHaveLength(0)
  })

  test("observe mode reports but does not abort at the maximum", async () => {
    const clock = new ManualClock()
    const events: McpDeadline.DeadlineEvent[] = []
    let resolveRemote = (_value: string) => {}
    let signal: AbortSignal | undefined
    const result = McpDeadline.supervise({
      clock,
      policy: { ...settings, mode: "observe" },
      observe: (event) => events.push(event),
      call: (input) => {
        signal = input.signal
        return new Promise<string>((resolve) => {
          resolveRemote = resolve
        })
      },
    })

    await Promise.resolve()
    clock.advance(100)
    expect(events).toHaveLength(1)
    expect(signal?.aborted).toBe(false)
    resolveRemote("ok")
    await expect(result).resolves.toBe("ok")
  })
})
