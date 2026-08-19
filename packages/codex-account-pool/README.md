# CyberVinci Codex Account Pool

Built-in multi-account ChatGPT OAuth rotation for CyberVinci. The server and TUI entrypoints are compiled into the CyberVinci distribution and enabled with the other default plugins, so users do not need to add a package or `file://` entry to their configuration.

The pool provides browser/device OAuth, per-session account binding, quota-aware failover, handoff summaries, resumable waiting jobs, and account management commands in the TUI. Its saved account order is explicit: the primary account is used first, then the secondary, tertiary, and any later accounts. Adding or reauthenticating an account does not silently promote it.

Data is stored under the CyberVinci XDG data directory. If a previous standalone installation already has data under the legacy OpenCode pool directory, CyberVinci keeps using that directory so existing accounts remain available.

## Handoff summary queue

The account pool does not require a summarizer model. With no model configured, account selection, quota failover, and handoff checkpoints continue to work without generated summaries. With one model, each due job makes at most one provider attempt before entering a persistent cooldown. With a primary and fallback, the fallback is attempted immediately after an eligible primary failure.

Summary work is persisted and serialized globally across CyberVinci processes. Routine idle updates return immediately; quota and emergency refreshes wait only for the configured bounded queue timeout. Rate limits open a per-model circuit (five minutes by default, or longer when `Retry-After` requires it), so later sessions are queued until the cooldown instead of repeating the same failing request.
