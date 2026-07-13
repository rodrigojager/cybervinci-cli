# Privacy And Security

- OAuth credentials remain local.
- Tokens are never returned by plugin tools or TUI dialogs.
- Settings do not contain credentials.
- Summarizer input removes common bearer tokens, API keys and token fields.
- Reasoning metadata and binary attachments are not sent to the summarizer.
- Tool outputs are bounded before summarization.
- The selected summarizer provider receives the redacted task context; review that provider's privacy policy.
- A free model is not necessarily private. Cost and privacy are independent choices.
- POSIX files use `0600` for credentials. Windows requires operating-system account protection.
- Logs do not include raw request bodies by default.

Structured summary output is validated and treated as data. Instructions found inside transcript excerpts are not trusted.
