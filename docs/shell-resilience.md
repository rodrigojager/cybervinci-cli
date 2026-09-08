# Shell execution resilience

The installation record below describes the first candidate. On September 8 it
was superseded by `resilience.2`; see [summary lifecycle safety](summary-lifecycle-safety.md)
for the current candidate, additional fixes, and verification evidence.

This change is developed from `d11952a0ba56d8b60d6287566275a4ba5729c4e2`
in the isolated `shell-resilience` worktree. It does not migrate session data,
change OAuth/account-pool state, or restart an existing CyberVinci process.

## Execution contract

- `CrossSpawnSpawner.exitCode` and `isRunning` observe OS process exit, independently
  of inherited stdout/stderr handles. Remaining pipes are closed after a 2-second
  post-exit drain allowance. Consumers that need output must collect the streams,
  not assume that awaiting the exit code also drains output.
- Termination has bounded graceful and forced phases (3 seconds each by default).
  Windows uses a hidden, bounded `taskkill.exe` invocation with explicit argv and
  the owned root PID, not a shell command or process-name-wide termination.
- An already-exited root is not killed again. Normal launchers may leave detached
  descendants alive. Windows Job Object containment is NOT introduced by this
  patch; descendants that escape the owned process tree are not guaranteed to die.
- The shell drains remaining output before returning. Progress publication is
  bounded and coalesced independently of pipe consumption. File flushing is also
  bounded; capture failures are reported instead of silently claiming complete output.
- Results distinguish completion, cancellation, timeout, capture error, and
  unconfirmed termination. Unconfirmed termination explicitly forbids automatic
  replay because the command may still have side effects in flight.
- Failed OS-exit notifications also settle execution immediately; they cannot
  lose a success-only race and be misreported as a later command timeout.
- Provider idle supervision uses monotonic elapsed time. Local execution still
  suspends the provider-idle check, but a tool with a claimed terminal outcome is
  not counted as executing. The global session-cycle timeout stays opt-in.

## Background commands

The existing `bash` tool retains its required `command` and optional `timeout`
and `workdir` parameters. `background: true` opts into prompt return of a job ID.
It does NOT remove or extend the command timeout.

Use `shell_job` with `action: list`, or with `job_id` and `action: status`, `wait`,
or `cancel`. `wait_ms` is limited to 0–30,000 ms and waiting does not cancel work.
Cancellation reports `stopping` until the runner has acknowledged its outcome.
Owner-scope shutdown without a returned runner result is conservatively recorded
as `termination_unconfirmed`, even when progress has not yet supplied a PID.

Jobs are scoped to the current process, workspace instance, and originating
session. Control calls recheck the existing `bash` permission; arbitrary PIDs and
other sessions' jobs cannot be targeted. Repeated retained tool-call IDs join the
existing job instead of launching a duplicate. Up to 32 unresolved jobs and 128
retained entries are allowed; live/unconfirmed jobs are never evicted to make room.

Status is intentionally process-local. On restart, an unknown job is NOT replayed
or presented as successfully completed. Completion is obtained through `shell_job`;
there is no automatic synthetic prompt that could unexpectedly resume user work.

## Reference and validation

The design comparison used the official Codex `rust-v0.153.4` sources:

- [exec.rs](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/exec.rs)
  (bounded output drainage and cancellation).
- [process_manager.rs](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/unified_exec/process_manager.rs)
  (bounded waits and process IDs).
- [windows_tests.rs](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/utils/pty/src/windows_tests.rs)
  (descendant termination/preservation).

Regression coverage includes real subprocesses under Bun and Node, Windows tree
termination, existing output/pipeline consumers, all four locally available shells,
cancel-before-launch, stalled metadata publication, owner isolation, cancellation
acknowledgement, and immutable terminal results. Tests use isolated configuration
and databases and do not use the user's account tokens.

The broad legacy shell permission suite has 17 failures on this Windows host.
All 17 also reproduce in the clean, separate baseline worktree at `d11952a0ba`:
drive-relative and `$PWD` paths, parent-directory navigation, external workdirs,
and external file arguments. The permission implementation was not changed here.
Do not report that the entire repository test suite is green.

Final targeted verification on this Windows host: **134 passing tests**:

- Core process/spawner/shell/background consumers: 76 passed, 0 failed.
- Shell/job resilience, cancellation and truncation: 21 passed, 0 failed.
- Session processor and tool registry: 37 passed, 0 failed.
- `bun run typecheck` passed in both `packages/core` and `packages/cybervinci`.
- `git diff --check` passed.

Commands (run from the indicated package, not the repository root):

```powershell
# packages/core
bun test test/effect/cross-spawn-spawner.test.ts test/process/process.test.ts test/shell.test.ts test/tool-bash.test.ts test/background-job.test.ts

# packages/cybervinci
bun test test/tool/shell-jobs.test.ts test/tool/shell.test.ts --test-name-pattern 'shell jobs|owner shutdown|shell cancellation|resilience|tool.shell abort|tool.shell truncation'
bun test --timeout 30000 test/tool/registry.test.ts test/session/processor-effect.test.ts
```

The final command's 30-second setting is the **test harness** allowance, not a
change to application deadlines. Some existing integration tests exceeded Bun's
default 5-second allowance on this host. Tests retain their own watchdog and
termination assertions. New multi-shell scenarios have a 15-second harness budget.

The failed-exit notification regression was observed failing before its fix and
passing afterward (the signal-style notification is injected after a real fixture
process exits). Owner shutdown was similarly verified with an interrupted job.
The historical user incidents were not replayed against live sessions; this is
coverage of the identified failure modes, not proof that every possible hang is
eliminated.

## Activation boundary

The compiled candidate is kept separate from `.cybervinci/bin/cybervinci.exe`.
Existing processes continue to execute their original code. They cannot receive
this fix without being restarted. Promotion of the candidate to the default CLI
must happen in a later safe maintenance window; do not hot-swap an active worker.

Installed side by side on 2026-09-08:

- Command: `cybervinci-next` (already resolvable through the existing PATH).
- Path: `C:\Users\Rodrigo\.cybervinci\bin\cybervinci-next.exe`.
- Version: `0.0.0-main-20260908-resilience.1`.
- SHA-256: `99D460D32FA2D24AC3CBBEC28C700C2D5C3267CB29F2B73DC68E0AD46A61792D`.
- Full Windows x64 build includes the Web UI. Installed binary `--version` and
  `--help` smoke checks passed with isolated home/config/data and an in-memory DB.

The default `cybervinci.exe` was not overwritten. Its SHA-256 remained
`BDC36DF606EF375ABD0BA0BA60A8F5FF28CA2122DF66CE6873D52642D47A1FFB` and the
observed existing process (PID 256884, started 2026-09-08 02:19:37 local) remained
running. Neither installation nor smoke verification used existing sessions.

Use the new command for a **new** session in the intended project directory.
Do not resume the same active session in two processes. Merely attaching a new
client to an old server does not update the server's execution code.

Parallel installation is reversible by ceasing to use `cybervinci-next`; the
original `cybervinci` command and installation are unchanged. No GitHub release
or default-installation promotion is performed by this change.
