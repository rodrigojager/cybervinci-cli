# Troubleshooting

## Pool provider does not appear

Run `cybervinci models openai-codex-pool`. If the provider is missing, confirm that `CYBERVINCI_DISABLE_DEFAULT_PLUGINS` is not enabled and that the running binary was built after the account-pool integration. No server or TUI plugin entry is required in user configuration.

Do not remove the standard OpenAI authentication path. The pool owns only `openai-codex-pool`; the built-in `openai` provider remains available independently.

## Recover when the pool prevents startup or login

Start once with `CYBERVINCI_CODEX_DATA_DIR` pointing to an empty recovery directory to isolate damaged pool state without touching the existing account store. To disable every default internal plugin temporarily, set `CYBERVINCI_DISABLE_DEFAULT_PLUGINS=true`; `--pure` disables external user plugins only.

## Browser login says another login is running

Complete or cancel the existing login. A stale lock is reclaimed after the browser-login timeout.

## Browser login says port 1455 is in use

Restart CyberVinci so it clears the current callback lifecycle. The pool cancels a stale callback when possible and falls back to the registered local port `1457`. If both ports are owned by unrelated processes, close those listeners or use headless/device login.

## Adding an account only updates the existing account

The pool deduplicates by ChatGPT workspace/account identity. Sign in to a different ChatGPT account in the browser (use a separate browser profile or private window when needed); a fresh login to the same identity correctly replaces its tokens instead of creating a duplicate.

## Quota is stale

Use `Refresh all quotas` in `/codex-accounts` or call `codex_quota_refresh`. The upstream `/wham/usage` endpoint may update lazily around reset boundaries.

## Accounts look exhausted immediately after a provider timeout

A caller-side header timeout cancels the whole CyberVinci request, not an individual Codex account. Current builds propagate that cancellation without adding account cooldowns or retrying other accounts with the already-aborted signal. If the log shows `ProviderHeaderTimeoutError` followed by `AllAccountsExhaustedError`, install the current CyberVinci build and restart every CyberVinci process.

## Summary is not updating

Check `/codex-handoff-status`, verify the configured provider/model exists in that CyberVinci instance, and use the popup's test action. If primary and fallback fail, deterministic goal/todo state remains available.

## Goal did not resume

Open `/codex-waiting`. Auto-resume requires a captured active goal, an existing idle session, a valid account, and confirmed available quota.

## Account removal remains queued

An active stream still owns a reservation. Removal completes after the stream ends or its stale lease expires.

## Recover from bad settings

Remove `settings.json` under `CYBERVINCI_CODEX_DATA_DIR` or the default CyberVinci pool data directory. Defaults are regenerated; accounts are unaffected. `OPENCODE_CODEX_DATA_DIR` remains a legacy alias.

## Recover from damaged account store

Do not hand-edit active tokens. Restore the `.v1.backup` or authenticate accounts again. Migration keeps the legacy file with a `.migrated` suffix.
