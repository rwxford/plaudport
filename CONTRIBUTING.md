# Contributing

PlaudPort is a small, local-first tool. Issues and PRs are welcome — especially
endpoint findings, since the Plaud web API is undocumented and shifts.

## Before you open anything

Read `SECURITY.md`. The short version: this repo is public, so no tokens, no
recordings, no transcripts, no HAR files, no un-redacted spike reports — in code,
in issues, or in PR descriptions.

## Setup

```bash
npm install
cp .env.example .env      # fill PLAUD_API_BASE + PLAUD_TOKEN
npm run hooks:install     # pre-commit secret check (recommended)
npm run spike             # read-only probes against your own account
```

## Before you push

```bash
npm run typecheck
npm run check:secrets
```

Both run in CI on every PR.

## Ground rules for changes

- **All endpoint knowledge stays in `src/config.ts` and `src/plaudClient.ts`.**
  When Plaud changes something, the fix should be one file, not a hunt.
- **Copy-only.** No code path may delete or modify anything in a source
  workspace. Writes go to the target workspace and to local disk only.
- **Guard writes.** Anything that writes to Plaud stays behind an explicit flag
  (`PLAUD_ALLOW_WRITE_TEST`) until it is a reviewed, deliberate feature.
- **Redact by default.** New reports and logs keep response shapes, not content
  (`src/redact.ts`).
- **New config goes in `.env.example`** with an empty or safe default, is parsed
  in `src/config.ts`, and is documented in the README table.

## Sharing endpoint findings

Fill in the table in `docs/ENDPOINTS.md` with paths, methods, and parameter
*names* — never a real recording id, workspace id, title, or token. Redacted
shapes from a spike report are the ideal evidence.
