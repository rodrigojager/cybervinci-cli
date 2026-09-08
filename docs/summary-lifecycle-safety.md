# Summary and history lifecycle safety

## Incident and scope

The September 8 investigation found a real `part` INSERT foreign-key failure:
revert cleanup removed an assistant message while its response still wrote parts.
The event journal showed a new text prompt, not a compaction marker, immediately
after cleanup. This is not evidence that the handoff summarizer caused that SQL
incident. The summarizer independently had an unsafe timeout/delete lifecycle.

No live database repair, event deletion, account edit, token refresh, process
restart, automatic retry of user work, or schema migration is part of this patch.
Existing foreign-key constraints stay enabled.

## Core protection

- Cancellation keeps admission in `Stopping` until the old fiber and its
  finalizers finish. Concurrent cancellation joins the same stop operation.
- New model work waits for cancellation to finish. Shell and destructive idle
  operations reject an active/stopping runner.
- Revert, unrevert, cleanup, and HTTP message/part deletion share the runner's
  admission lock, rather than checking busy and deleting later.
- Cleanup rereads the revert state inside the lock. Reusing an old session
  snapshot cannot delete messages added after an earlier cleanup.
- Shell preparation cleans reverted history before entering the shell runner,
  avoiding a nested lock against itself.
- Idle notifications stay outside admission locks because event listeners can
  re-enter the controller. Runner identity is retained for the workspace-instance
  lifetime so concurrent callers cannot acquire different locks for one session.
- Existing HTTP error contracts are preserved: busy message deletion returns
  409; summarize, prompt, command, and part deletion use their existing 400
  contract when guarded cleanup cannot run. No generated client changes needed.

These are legacy, process-local execution guards. They are not clustered locking,
V2 execution migration, or permission to resume one session in two processes.

## Pool summarizer protection

The built-in package and standalone repository contain identical summarizer
source and lifecycle tests.

- SDK error envelopes are checked explicitly, including session creation.
- After timeout or request failure, cleanup requests server cancellation and
  joins the outstanding prompt before deletion. A successful prompt response
  itself proves that the writer finished.
- Abort and join waits are independently bounded at 5 seconds each; deletion
  is also bounded at 5 seconds. No timeout grants permission to delete a possible
  writer. The original prompt transport is not prematurely aborted.
- If shutdown is uncertain, the coordinator retains the internal session and
  blocks replacement attempts for that parent in that coordinator. Other parent
  sessions can use the queue. This in-memory ownership fence does not survive a
  coordinator restart and is not a cross-process execution lease.
- A late normal response triggers safe cleanup without another model request.
- A failed deletion can leave an inert internal record, but does not hold the
  queue indefinitely. Existing orphan records are not automatically erased.
- Provider cooldowns, model choice, fallback categories, and quota policy remain
  unchanged. HTTP 429 is still a provider rate limit, not an INSERT failure.

## Validation and limitations

Tests use temporary databases/configuration and mock providers, not live chats
or the user's credentials. Regression coverage includes a real database writer
attempting a late part update, stale cleanup, busy HTTP routes, cancellation
finalizers, re-entrant notifications, timeout/abort/join ordering, failed SDK
envelopes, hanging abort/delete calls, and late-response cleanup.

Type checks passed in CyberVinci, the integrated pool, and the standalone pool.
Runner, history/revert, and session-route suites passed 42 tests with zero failures.
The integrated pool suite passed 65 tests. The final compaction run passed 54
tests with one platform skip and the separately audited timing test excluded.
Standalone `bun run check` passed tests, JS/declaration build, import smoke, and
package dry-run. The Windows x64 executable includes the Web UI and passed its
build-time and installed version/help smoke checks.

Do not describe the entire legacy suite as green. The clean baseline also failed
`running task tool preserves metadata after tool-call transition`,
`loop sets status to busy then idle` (3-second harness limit), and
`cancel with queued callers resolves all cleanly` (10-second limit). The old
compaction retry-backoff timing test failed its 250 ms assertion in the candidate
and its 10-second harness allowance in the clean baseline. These tests were not
weakened or changed by this patch. A broad run using an earlier intermediate
revision was interrupted; the final targeted results are recorded separately.

No live provider handoff or real agent-browser workflow was executed against
the user's ongoing sessions. This fixes the identified races, not every possible
hang or external-provider failure.

## Side-by-side installation

- Command: `cybervinci-next` in a new session in the desired project directory.
- Version: `0.0.0-main-20260908-resilience.2`.
- Path: `C:\Users\Rodrigo\.cybervinci\bin\cybervinci-next.exe`.
- SHA-256: `CA6B6548C38793623F579154036A85852B5A8E0EF450EF026303E4A0DC260B65`.
- Previous candidate backup: `cybervinci-resilience-1.backup.exe` in the same folder.

The default `cybervinci.exe` remains unchanged with SHA-256
`BDC36DF606EF375ABD0BA0BA60A8F5FF28CA2122DF66CE6873D52642D47A1FFB`.
PID 256884, started at 02:19:37 local, was still running after installation.
Attaching to an old server does not activate the new code. Do not resume the
same active session concurrently. Default-command promotion and GitHub publishing
are not performed by this change.

Standalone source/distribution commit: `5c60e38` on local branch `summary-safety`.
Packaged candidate (not activated in another running host):
`C:\Users\Rodrigo\.cybervinci\staged\codex-pool-summary-20260908\opencode-codex-account-pool-0.1.1.tgz`.
Archive SHA-256: `224747C6E3A160CA8EFC976F9F9F1DFA5DBF6D4132EDF289BE17009145A11D4B`.
