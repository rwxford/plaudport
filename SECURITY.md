# Security

PlaudPort runs on your own machine, against your own Plaud account, using a
token that grants full access to that account for months. Treat it accordingly.

## What must never enter this repository

This repository is public. The following are never committed, and CI fails the
build if they show up (`npm run check:secrets`):

- `.env` or any filled-in env file — only `.env.example`, with empty values
- Plaud bearer tokens, session cookies, or any `Authorization` header value
- Recordings, transcripts, summaries, or exported manifests
- The SQLite ledger, run reports, or reconciliation CSVs
- Screenshots or HAR files of DevTools sessions (a HAR contains your token)

Everything the tool produces is written under `PLAUD_DATA_DIR` (default
`./data`), which is gitignored in full.

## Handling your token

- Capture it as described in `docs/ENDPOINTS.md` and put it in `.env`.
- From M1 onward it belongs in the macOS Keychain; `.env` is the M0 stopgap.
- It is not scoped or read-only — anyone holding it can read and modify your
  entire Plaud account. Rotate it (log out on web.plaud.ai, sign back in) if you
  suspect it leaked.
- The client sends it only to hosts in `PLAUD_ALLOWED_HOSTS`.

## Reporting an issue

Open a GitHub issue for bugs. **Do not paste tokens, real endpoint responses,
recording ids, or transcript text into an issue or PR.** Run the spike with
`PLAUD_REDACT_SAMPLES=true` (the default) and share the redacted report, which
keeps response shapes and drops content.

For anything you believe is a security flaw rather than a bug, use GitHub's
private vulnerability reporting on this repository instead of a public issue.

## Design invariants

These are enforced in code, not just documented (see `docs/PRD.md` §8):

- **Copy-only** — the tool never deletes or modifies anything in the source workspace.
- **Backup-before-migrate** — migration is gated on a verified local backup.
- **Loopback-only** — the M4 web UI binds `127.0.0.1`; there is no remote surface.
- **Host allowlist** — outbound requests are restricted to configured Plaud hosts.
- **Redaction by default** — reports keep shapes, not content.

## Unofficial API

PlaudPort talks to Plaud's undocumented web API because no public one exists. It
acts as you, on your own data, at human-ish rates. It may break without notice.
You are responsible for your own use of it under Plaud's terms of service.
