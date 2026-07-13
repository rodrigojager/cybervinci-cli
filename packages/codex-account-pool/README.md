# CyberVinci Codex Account Pool

Built-in multi-account ChatGPT OAuth rotation for CyberVinci. The server and TUI entrypoints are compiled into the CyberVinci distribution and enabled with the other default plugins, so users do not need to add a package or `file://` entry to their configuration.

The pool provides browser/device OAuth, per-session account binding, quota-aware failover, handoff summaries, resumable waiting jobs, and account management commands in the TUI.

Data is stored under the CyberVinci XDG data directory. If a previous standalone installation already has data under the legacy OpenCode pool directory, CyberVinci keeps using that directory so existing accounts remain available.
