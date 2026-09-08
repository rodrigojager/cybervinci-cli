import { Effect, Schema } from "effect"
import { Tool } from "./tool"
import { ShellJobs } from "./shell/jobs"
import { ShellID } from "./shell/id"

const Parameters = Schema.Struct({
  job_id: Schema.optional(Schema.String),
  action: Schema.Literals(["list", "status", "wait", "cancel"]),
  wait_ms: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30_000 }))),
})

export const ShellJobTool = Tool.define(
  "shell_job",
  Effect.gen(function* () {
    const jobs = yield* ShellJobs.Service
    return {
      description:
        "Inspect, wait for, or cancel a shell command launched with background=true. Jobs belong to this session and this running CyberVinci process. Results are not restored after restart. Never rerun a missing or unconfirmed job automatically. Waiting is bounded and does not cancel the command.",
      parameters: Parameters,
      execute: (
        params: typeof Parameters.Type,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<Record<string, unknown>>> =>
        Effect.gen(function* () {
          if (params.action === "list") {
            const list = yield* jobs.list(ctx.sessionID)
            yield* ctx.ask({
              permission: ShellID.ToolID,
              patterns: list.map((job) => job.command),
              always: [],
              metadata: {},
            })
            return {
              title: "Shell jobs",
              metadata: {},
              output:
                list.map((job) => `${job.id}: ${job.status} — ${job.command}`).join("\n") ||
                "No shell jobs in this session/process.",
            }
          }
          if (!params.job_id) return yield* Effect.die(new Error("job_id is required for status, wait, and cancel"))
          const current = yield* jobs.get(ctx.sessionID, params.job_id)
          if (!current)
            return yield* Effect.die(
              new Error(
                "Shell job unavailable in this session/process. Do not rerun automatically; verify whether the original command is still active.",
              ),
            )
          yield* ctx.ask({
            permission: ShellID.ToolID,
            patterns: [current.command],
            always: [current.command],
            metadata: {},
          })
          const info =
            params.action === "cancel"
              ? yield* jobs.cancel(ctx.sessionID, params.job_id)
              : params.action === "wait"
                ? yield* jobs.wait(ctx.sessionID, params.job_id, params.wait_ms ?? 10_000)
                : current
          if (!info) return yield* Effect.die(new Error("Shell job no longer available"))
          return {
            title: info.command,
            metadata: { ...info.metadata, jobId: info.id, status: info.status },
            output: `Shell job ${info.id}: ${info.status}\n${info.output || "(no output yet)"}`,
          }
        }),
    }
  }),
)
