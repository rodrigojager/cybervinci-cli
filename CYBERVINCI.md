# CYBERVINCI

CYBERVINCI is an unofficial fork of OpenCode focused on ensuring that tool and MCP operations cannot leave a session permanently busy. This checkout is based on OpenCode `v1.17.18`, commit `b1fc8113948b518835c2a39ece49553cffe9b30c`.

## Reliability changes

- MCP execution has an idle timeout from the existing MCP configuration plus an independent wall-clock maximum.
- Progress may renew the idle timeout but cannot renew the maximum.
- Escape/cancellation has a bounded grace period; a remote tool that ignores `AbortSignal` is detached from the session after that budget.
- The normal MCP path and Code Mode share the same deadline supervisor.
- Tool calls are registered before execution and success/error is persisted directly by the wrapper.
- Terminal state is claimed once per `callID`; duplicate and late results cannot overwrite it.
- Timeout metadata includes `reliabilityReason`, `deadlineMs`, `elapsedMs`, and `lastProgressAt` when available.

Runtime controls:

```text
CYBERVINCI_RELIABILITY_MODE=off|observe|enforce
CYBERVINCI_MCP_MAX_TIMEOUT_MS=43200000
CYBERVINCI_CANCEL_GRACE_MS=2000
CYBERVINCI_PROVIDER_IDLE_TIMEOUT_MS=300000
CYBERVINCI_SESSION_CYCLE_TIMEOUT_MS=900000
CYBERVINCI_TERMINAL_PERSIST_TIMEOUT_MS=1000
CYBERVINCI_CLEANUP_TIMEOUT_MS=15000
CYBERVINCI_WEB_UI_URL=https://explicitly-trusted.example
CYBERVINCI_ENABLE_OPENCODE_COMPAT=true
```

The default mode is `enforce`. MCP calls retain their per-server idle timeout and also have a 12-hour hard maximum. Provider streams have a 5-minute idle watchdog, a session cycle has a 15-minute ceiling, terminal persistence has a 1-second wait budget, and cleanup has a 15-second ceiling.

`CYBERVINCI_WEB_UI_URL` is optional and must point to an explicitly trusted web UI. When no UI is embedded and this variable is unset, the server returns a local 503 response instead of proxying the OpenCode product UI. `CYBERVINCI_ENABLE_OPENCODE_COMPAT=true` opt-ins to the legacy `OPENCODE=1` process marker for third-party plugins that still require it.

## Build on Windows

Install Bun `1.3.14`, then run from the repository root:

```powershell
bun install --frozen-lockfile
bun run typecheck
bun run packages/cybervinci/script/build.ts --single --baseline --skip-install
```

The native binaries are produced at:

```text
packages/cybervinci/dist/cybervinci-windows-x64/bin/cybervinci.exe
packages/cybervinci/dist/cybervinci-windows-x64-baseline/bin/cybervinci.exe
```

Verify it with:

```powershell
.\packages\cybervinci\dist\cybervinci-windows-x64\bin\cybervinci.exe --version
.\packages\cybervinci\dist\cybervinci-windows-x64\bin\cybervinci.exe --help
```

For a local Unix-style install, use only a binary you built or verified:

```bash
./install --binary /path/to/cybervinci
```

Build the native Windows Setup and GitHub release assets with:

```powershell
./installer/windows/build.ps1 `
  -Version "1.17.18-cybervinci.1" `
  -Repository "OWNER/REPOSITORY" `
  -OutputDirectory "./dist/windows-installer"
```

The Setup installs the correct x64 or x64-baseline executable into `%USERPROFILE%\.cybervinci\bin`, updates the user `PATH` idempotently, and registers a Windows uninstaller. Once the generated assets are published from an owned GitHub repository, installation is one command:

```powershell
irm https://github.com/OWNER/REPOSITORY/releases/latest/download/install.ps1 | iex
```

There is intentionally no public CYBERVINCI update feed yet. The installer workflow prepares repository-scoped release assets but does not infer or download OpenCode artifacts. CLI and Desktop automatic updates remain disabled. External updates require `CYBERVINCI_ENABLE_EXTERNAL_UPDATES=true`, an explicit `CYBERVINCI_RELEASE_API_URL`, and method-specific trusted targets such as `CYBERVINCI_NPM_PACKAGE` or `CYBERVINCI_HOMEBREW_FORMULA`.

## Branding and service compatibility

- Canonical command: `cybervinci`
- Canonical config/data names: `cybervinci.json[c]`, `.cybervinci`, `cybervinci.db`
- Canonical environment prefix: `CYBERVINCI_`
- Canonical internal package scope: `@cybervinci-ai/*`
- Canonical Desktop protocol: `cybervinci://`
- `opencode://` remains accepted only as a migration alias.
- OpenCode Zen, OpenCode Go, OpenCode Console, provider IDs such as `opencode` and `opencode-go`, `OPENCODE_API_KEY`, service URLs, OAuth client identifiers, and `x-opencode-*` service headers remain unchanged.

## Validation scope

This deliverable is a tactical Windows x64 build. It includes focused reliability and HTTP UI regression tests, App/Core/TUI/GitHub Action typechecks, the full workspace typecheck, web and desktop production builds, and native CLI smoke checks. It does not claim the five-week certification plan from the design note has been completed: no seven-day soak, full provider matrix, multi-OS certification, or hostile process-tree campaign was run.

## License and status

The upstream MIT license and copyright are preserved in [LICENSE](LICENSE). See [NOTICE](NOTICE) for attribution and non-affiliation. CYBERVINCI is not an official OpenCode release.
