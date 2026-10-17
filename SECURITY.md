# Security

PlaudPort runs on your own machine, against your own Plaud account, using a
session credentials that grant full access to that account. Treat it accordingly.

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

- Sync current credentials from Chrome as described in `docs/CHROME-AUTH.md`,
  or capture them manually as described in `docs/ENDPOINTS.md`.
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

## Chrome credential sync

The optional Manifest V3 extension observes only `https://api.plaud.ai/file/*`
requests initiated by `https://web.plaud.ai`. It forwards only `authorization`,
`x-pld-user` and `x-device-id` from a single request through Chrome native
messaging to the local helper. It does not forward cookies, request URLs,
request bodies, recordings or transcripts. It has no content scripts, browser
storage, external messaging, or listening network port. Captured credentials
exist in extension memory until the worker stops, never in extension storage.

The helper accepts only the extension's fixed origin. Its destination is the
Mac's `~/Library/Application Support/PlaudPort/chrome-auth.env`, fixed at installation, never a path from a browser message.
It rejects expired or malformed JWTs, unsafe header characters and symlinked
credential files; it replaces the file atomically with mode `0600` under a
writer lock. JWT inspection checks format and expiry, **not** the signature or
whether Plaud accepts the session: use `npm run check:auth` for that check.
Responses and extension status contain no credential values. Temporary credential files and locks stay alongside that private store.

The helper runtime is copied into Application Support, so Chrome need not run
scripts inside protected Documents folders. Chrome's host manifest and launcher contain local paths and the public
extension ID, not credentials. The extension manifest's `key` is a **public**
key used for a stable extension ID. No private signing key is retained. Load the
extension only in the Chrome profile used for the intended Plaud account and
workspace. Anyone with access to your macOS account can read its credential store and `.env`; this
integration does not protect against a compromised local user account.

## Web UI result actions

The web UI's connection check asks Plaud for an upload target and discards it;
no recording is created. Session presence/expiry is displayed separately from
this live verification. The bearer and session headers never go to the page.

Opening a backup in Finder requires the same local session token as importing.
The client supplies only a job ID and recording index; the server chooses the
path from its own archive results and checks its real path stays inside the
share archive directory, rejecting escaping symlinks. It never accepts a file
path or shell command from the page. Recording titles and errors are rendered
as text, never HTML.
