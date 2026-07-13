# CYBERVINCI

CYBERVINCI is an unofficial OpenCode fork focused on preventing tool and MCP execution from leaving sessions permanently busy. This checkout is based on OpenCode `v1.17.18` at commit `b1fc8113948b518835c2a39ece49553cffe9b30c`.

The product-facing command, packages, configuration, data paths, TUI, and Desktop shell use the CYBERVINCI name. OpenCode Zen, OpenCode Go, OpenCode Console, and their external provider/protocol identifiers keep their service names for compatibility.

## Current status

- The Windows native CLI builds and runs from this checkout.
- Reliability enforcement is enabled by default for MCP/tool deadlines and terminal settlement.
- The Codex Account Pool server and TUI plugins are built in and enabled by default.
- A per-user Windows CLI Setup now installs `cybervinci` globally and registers a Windows uninstaller.
- There is no public CYBERVINCI release or automatic-update feed yet.
- GitHub-ready installer assets can be built locally or with the isolated Windows installer workflow; they are not an official public feed until uploaded to a CYBERVINCI-owned repository.

The implementation notes, reliability controls, and exact artifact path are documented in [CYBERVINCI.md](CYBERVINCI.md).

## Install on Windows

The local Setup installs into `%USERPROFILE%\.cybervinci`, places the command in `.cybervinci\bin`, adds that directory to the user `PATH`, and appears as `CYBERVINCI CLI` in Windows Installed Apps.

After the release assets are uploaded to an owned GitHub repository, the generated release bootstrap supports one-command installation:

```powershell
irm https://github.com/rodrigojager/cybervinci-cli/releases/latest/download/install.ps1 | iex
```

The release copy of `install.ps1` has `rodrigojager/cybervinci-cli` embedded by the installer build. It downloads only the CYBERVINCI Setup asset from that repository and verifies its external SHA-256 file before execution.

## Build locally

CYBERVINCI currently targets Bun `1.3.14`. From the repository root on Windows:

```powershell
bun install --frozen-lockfile
bun run typecheck
bun run packages/cybervinci/script/build.ts --single --baseline --skip-install
```

The native executables are written to:

```text
packages/cybervinci/dist/cybervinci-windows-x64/bin/cybervinci.exe
packages/cybervinci/dist/cybervinci-windows-x64-baseline/bin/cybervinci.exe
```

Verify and run it directly:

```powershell
.\packages\cybervinci\dist\cybervinci-windows-x64\bin\cybervinci.exe --version
.\packages\cybervinci\dist\cybervinci-windows-x64\bin\cybervinci.exe --help
.\packages\cybervinci\dist\cybervinci-windows-x64\bin\cybervinci.exe
```

Build the Windows Setup and GitHub release assets with:

```powershell
./installer/windows/build.ps1 `
  -Version "1.17.18-cybervinci.1" `
  -Repository "rodrigojager/cybervinci-cli" `
  -OutputDirectory "./dist/windows-installer"
```

For a local Unix-style installation, pass a binary you built or verified:

```bash
./install --binary /absolute/path/to/cybervinci
```

The Bash installer remains intended for Unix/WSL. Native Windows installation uses [install.ps1](install.ps1) and the Setup documented in [installer/windows](installer/windows/README.md). Automatic application updates remain disabled until an explicit trusted CYBERVINCI feed is configured.

## Reliability controls

```text
CYBERVINCI_RELIABILITY_MODE=off|observe|enforce
CYBERVINCI_MCP_MAX_TIMEOUT_MS=43200000
CYBERVINCI_CANCEL_GRACE_MS=2000
CYBERVINCI_PROVIDER_IDLE_TIMEOUT_MS=300000
CYBERVINCI_SESSION_CYCLE_TIMEOUT_MS=900000
CYBERVINCI_TERMINAL_PERSIST_TIMEOUT_MS=1000
CYBERVINCI_CLEANUP_TIMEOUT_MS=15000
```

The default mode is `enforce`. Progress can renew an idle timeout, but it cannot renew the independent maximum deadline. Cancellation has a bounded grace period, and late tool results cannot overwrite an already settled terminal state.

## Built-in Codex account pool

CyberVinci includes multi-account ChatGPT OAuth rotation without a separate plugin installation or `file://` configuration. Open **Codex: Manage accounts** in the TUI to add accounts, inspect quotas, choose the active/default account, and manage failover. The provider is exposed as `openai-codex-pool`.

The pool stores new data under the CyberVinci XDG data directory and automatically keeps using an existing legacy OpenCode pool directory when one is already present. The explicit overrides are `CYBERVINCI_CODEX_DATA_DIR` and `CYBERVINCI_CODEX_ACCOUNTS_PATH`; the older `OPENCODE_CODEX_*` variables remain migration aliases.

## Local configuration

- Command: `cybervinci`
- Project configuration: `cybervinci.json` or `cybervinci.jsonc`
- Project directory: `.cybervinci/`
- Global configuration directory: `~/.config/cybervinci/`
- Environment prefix: `CYBERVINCI_`
- Internal package scope: `@cybervinci-ai/*`
- Desktop protocol: `cybervinci://`

The legacy `opencode://` protocol is accepted only as a migration alias. Service-facing provider IDs, API keys, OAuth identifiers, and `x-opencode-*` headers remain unchanged where OpenCode service compatibility requires them.

## Development

Useful focused commands from the repository root:

```powershell
bun turbo typecheck --force
bun test packages/cybervinci/test/mcp/deadline.test.ts
bun test --timeout 30000 --preload packages/cybervinci/test/preload.ts packages/cybervinci/test/session/processor-effect.test.ts --test-name-pattern "mark pending tools|keep the first|create one part|never-ending provider stream"
bun test --timeout 30000 --preload packages/cybervinci/test/preload.ts packages/cybervinci/test/installation/installation.test.ts
bun --cwd sdks/vscode run check-types
```

The full package test runner loads an OpenTUI preload that may keep Bun alive on some hosts. Use the explicit preload commands above for the focused regression gate, and report exactly which checks ran.

## Documentation

- [CYBERVINCI implementation and build notes](CYBERVINCI.md)
- [Contribution guide](CONTRIBUTING.md)
- [License](LICENSE)
- [Upstream attribution and non-affiliation notice](NOTICE)

Localized README files are temporary pointers until their translations are reviewed against this fork's current build and distribution status.

## Upstream

CYBERVINCI is derived from [OpenCode](https://github.com/anomalyco/opencode), specifically the upstream [`v1.17.18` release](https://github.com/anomalyco/opencode/releases/tag/v1.17.18). OpenCode is distributed under the MIT License. CYBERVINCI is not affiliated with, endorsed by, or maintained by the OpenCode project or anomalyco.
