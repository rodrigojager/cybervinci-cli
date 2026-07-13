# Contributing to CYBERVINCI

CYBERVINCI is a compatibility fork focused on bounded execution, truthful terminal state, and independent product branding.

Before changing code:

1. Read `README.md` and `CYBERVINCI.md`.
2. Keep official OpenCode service names, provider IDs, headers, and API keys unchanged where compatibility requires them.
3. Do not add downloads, update feeds, package names, social accounts, or support URLs unless the operator controls and verifies them.
4. Add a focused regression test for reliability changes.

Use Bun 1.3.14 and run:

```bash
bun install
bun turbo typecheck --force
```

For hang-hardening changes, run the focused deadline and processor tests documented in `CYBERVINCI.md`. Run `git diff --check` before handing off a patch.

This checkout has no configured public contribution or support endpoint. Send changes and reports to the maintainer of the CYBERVINCI distribution you received. Upstream attribution and license details are in `NOTICE`.
