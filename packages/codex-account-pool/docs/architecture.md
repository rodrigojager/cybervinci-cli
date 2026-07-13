# Architecture

## Runtime split

`src/server.ts` registra auth, hooks, tools e transporte como plugin interno do host. `src/tui.tsx` registra comandos e dialogs como plugin interno da TUI. As duas entradas compartilham os mesmos schemas e stores e são compiladas diretamente na distribuição do CyberVinci.

## State scopes

| State | Scope |
|---|---|
| Settings and account pool | Global |
| Quota cache | Account |
| Account binding | Session |
| Goal ledger | Session |
| Summary | Session |
| Context epoch | Session |
| Resume job | Session with cross-process lease |

## Request path

```text
CyberVinci -> provider fetch -> session binding -> account selector -> token refresh
            -> Codex endpoint -> outcome/quota -> stream reservation release
```

Selection is sticky while the bound account is healthy. Hard failures can fail over. A proactive handoff happens only at an idle boundary.

## Context epochs

Each handoff creates an epoch containing source/target account, cutoff message, summary revision and checkpoint. `experimental.chat.messages.transform` applies the cutoff on every later model call, so old messages cannot reappear on turn two after a handoff.

The original session transcript is untouched. The transform operates on cloned request messages.

## Summary path

```text
session.idle -> immutable snapshot -> child session -> primary model
             -> optional fallback -> schema validation -> compare-and-swap commit
```

Concurrent idle events coalesce. Stale outputs cannot replace summaries based on newer messages.

## Persistence

Writes use an in-process queue, `wx` cross-process lock, unique temporary file and atomic rename. Stores have independent lock keys to avoid global serialization.

## Scheduler

Waiting jobs are persistent. A runtime instance claims a due job with a lease. It verifies session, goal, auth and quota before sending a synthetic resume marker with explicit agent/model/variant.

## Account removal

The TUI disables the account and enqueues an action. The server waits for active reservations, creates handoffs for affected sessions, rebinds them, and only then removes credentials.
