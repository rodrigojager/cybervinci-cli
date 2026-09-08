# OAuth recovery and temporary account unavailability

The pool is an independent multi-account extension. The official OpenCode and Codex clients are references for OAuth handling, not implementations of this pool.

A valid quota does not clear a cooldown caused by a failed request. Older versions could also treat a local file-write failure after HTTP 200 as an account failure, leaving healthy accounts unavailable for five minutes.

The corrected implementation:

- Retries atomic file replacement for up to two seconds on Windows sharing errors, preserving the existing account file throughout.
- Keeps local persistence and notification failures outside account failure handling.
- Reloads credentials under a cross-process lock and refreshes the exact token rejected with HTTP 401, even if its recorded expiration is in the future.
- Reuses credentials already refreshed by another instance, and preserves account identity headers on each attempt.
- Releases reservations on refresh failures and limits failover to the configured number of attempts.
- Clears authentication cooldown when an existing account is reconnected, while preserving usage quotas and historical counters.
- Distinguishes temporary unavailability, quota exhaustion, and missing accounts. Rejected refresh tokens produce reconnection guidance without logging response bodies or credentials.

Regression coverage uses a local HTTP OAuth server, concurrent pool instances, and a real Windows file handle that temporarily denies replacement. Run `bun test` and `bun typecheck` from the package directory.

References checked on 2026-09-08:

- [Codex OAuth manager: reload, refresh, and unauthorized recovery](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs)
- [OpenCode Codex OAuth implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/openai/codex.ts)
