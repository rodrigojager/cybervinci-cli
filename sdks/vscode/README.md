# CYBERVINCI for VS Code

This extension opens the locally installed CYBERVINCI CLI in an integrated VS Code terminal and can send the active file or selection to that terminal.

## Prerequisite

Build CYBERVINCI from this repository and make the `cybervinci` executable available on `PATH`. See [the repository README](../../README.md) and [the local build notes](../../CYBERVINCI.md). The extension does not download or update the CLI.

## Features

- `Cmd+Esc` on macOS or `Ctrl+Esc` on Windows/Linux focuses an existing CYBERVINCI terminal or opens one.
- `Cmd+Shift+Esc` on macOS or `Ctrl+Shift+Esc` on Windows/Linux opens a new CYBERVINCI terminal.
- `Cmd+Option+K` on macOS or `Alt+Ctrl+K` on Windows/Linux inserts a file reference for the active editor selection.
- Editor title actions can open CYBERVINCI and pass the current file as context.

## Development

Open `sdks/vscode` as the VS Code workspace, then run:

```bash
bun install
bun run check-types
bun run lint
```

Press `F5` to launch an Extension Development Host. The extension is under local development; use this repository's own issue tracker once a CYBERVINCI remote is configured.