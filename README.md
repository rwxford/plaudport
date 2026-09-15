# PlaudPort

Local-first, single-user tool (macOS) for getting Plaud recordings where you need
them, so they're reachable by the Plaud MCP from Claude.

Two jobs, in priority order:

1. **Import a shared meeting into your Plaud** *(primary)* — someone sends you a
   `web.plaud.ai/s/pub_…` share link; this pulls it into your **Personal**
   workspace as a real recording, audio and original transcript intact.
   See `docs/PRD-SHARE-IMPORT.md`.
2. **Consolidate Personal → Team** *(secondary)* — back up everything you own and
   copy your own recordings into the Team workspace, private to you.
   See `docs/PRD.md`.

Runs entirely on your own machine. Nothing is hosted, and no data goes anywhere
except between your Mac and Plaud.

## Status
**Share import:** both halves built. Fetching a share needs no credentials at
all; uploading into your own workspace needs `PLAUD_USER_TOKEN`. The upload path
is written from a real captured import and passes an end-to-end self-test against
a stand-in API — but has not yet run against live Plaud.

Not yet possible: attaching the original transcript to the uploaded copy, so
Plaud re-transcribes it. The original is preserved locally regardless.

**Migration:** a **read-only spike** for Plaud's unofficial web API.

## Why this exists
- Plaud has no public general-purpose API.
- The official Plaud MCP is **read-only** — it can't import or write.
- Personal and Team workspaces are walled off; only audio imports natively, and
  transcripts/summaries don't carry over. This tool fills those gaps.
- Copies land **private inside Team**, which keeps them readable by the Plaud MCP.
  (As of 2026-08 the MCP sees Personal files and private Team files, but *not*
  files moved into the shared "Team files" folder — so promoting a file there is
  a manual, deliberate choice. See `docs/PRD.md` §3.)

## Safety model
- **Copy-only.** Never deletes or moves Personal originals.
- **Backup-before-migrate.** Migration is blocked until a verified backup exists.
- **Local-only.** Binds to `127.0.0.1`; audio never leaves your Mac except to Plaud.
- **Secrets** live in `.env` (gitignored) and, from M1, the macOS Keychain — never
  in the repo, reports, or logs.
- **Redacted by default.** Run reports keep response *shapes*, not content.
- Uses an **unofficial, reverse-engineered API** that may break without notice.

## This repository is public
Nothing account-specific belongs in it. Your token, recordings, transcripts,
ledger, and reports all live under `./data` and `.env`, both fully gitignored,
and `npm run check:secrets` (also a CI step, and installable as a pre-commit
hook) fails the build if any of them get staged. See `SECURITY.md`.

## Requirements
- macOS, Node.js ≥ 20
- For share-link import: nothing else — no login, no config
- For the migration side: a Plaud account with Personal + Team workspaces, and a
  bearer token captured from web.plaud.ai (see `docs/ENDPOINTS.md`)

## Quick start — archive a shared meeting

```bash
npm install
npm run fetch:share -- "https://web.plaud.ai/s/pub_xxxxxxxx::xxxxxxxx"
```

That's it. **No Plaud login, no token, no configuration** — a share link is its
own authorisation (see `docs/SHARE-API.md`). One command pulls down:

- `audio.mp3` — the recording, checksummed
- `transcript.txt` — the original transcript, `[mm:ss] Speaker: text`
- `transcript-polished.txt` — Plaud's AI-cleaned version
- `recording.md` — title, date, length, summary, outline and both transcripts in
  one readable document
- `detail.json` + `manifest.json` — the raw response and an integrity record

Everything lands in `data/shares/<share-id>-<title>/`. Re-running is safe: if the
audio is already there and its checksum matches, it isn't downloaded again.

Then import it into your own Plaud workspace, keeping the meeting's original
title and date:

```bash
npm run import:audio -- --from-share data/shares/<folder>
```

That step needs `PLAUD_USER_TOKEN` in `.env` (the `x-pld-user` header from a
signed-in session — see `docs/UPLOAD-API.md`). Add `--dry-run` to see exactly
what it would send first.

For the migration spike (needs your own token):

```bash
cp .env.example .env       # then fill PLAUD_API_BASE + PLAUD_TOKEN
npm run hooks:install      # optional: pre-commit secret check
npm run spike              # read-only probes; writes data/spike-report.json
```

## Configuration
All settings come from the environment; `.env.example` is the template.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PLAUD_API_BASE` | yes | — | Origin + path prefix of the Plaud web API |
| `PLAUD_TOKEN` | yes | — | Bearer token from web.plaud.ai (**secret**) |
| `PLAUD_USER_TOKEN` | for upload | — | `x-pld-user` header from a signed-in session (**secret**) |
| `PLAUD_DEVICE_ID` | for upload | generated | `x-device-id` from that same session |
| `PLAUD_AUTH` | maybe | — | `Authorization` header, if Plaud sends one (**secret**) |
| `PLAUD_COOKIE` | maybe | — | `Cookie` header, if Plaud authenticates by cookie (**secret**) |
| `PLAUD_EXTRA_HEADERS` | no | — | JSON of extra headers, if your account needs them |
| `PLAUD_ALLOWED_HOSTS` | no | Plaud web/api/resource + both S3 buckets | SSRF guard for every outbound call |
| `PLAUD_DATA_DIR` | no | `./data` | Where backups, ledger, and reports are written (gitignored) |
| `PLAUD_REQUEST_TIMEOUT_MS` | no | `30000` | Per-request timeout |
| `PLAUD_REDACT_SAMPLES` | no | `true` | Strip string values out of report samples |
| `PLAUD_ALLOW_WRITE_TEST` | no | `false` | Unlocks the guarded M0 write test |

Later milestones add a few more (local UI bind/port, concurrency, backup
freshness); they're listed and commented out at the bottom of `.env.example`.

## Scripts
| Command | What it does |
|---|---|
| `npm run fetch:share -- "<link>"` | **Archive a shared meeting**: audio + transcript + notes |
| `npm run probe:share -- "<link>"` | Report what a public share link exposes |
| `npm run import:audio -- --from-share <dir>` | **Upload** an archived recording into your workspace |
| `npm run check:auth` | Check your upload credentials without uploading anything |
| `npm run fetch:audio -- --from-scan` | Download audio found by `scan:har` (fallback route) |
| `npm run scan:har -- <file.har>` | Derive the endpoint map from a DevTools HAR export |
| `npm run scan:upload -- <file.har>` | Work out how the web app uploads audio (for the import step) |
| `npm run demo` | End-to-end self-test with a fake share page — no Plaud needed |
| `npm test` | Unit tests |
| `npm run spike` | M0 read-only probes → `data/spike-report.json` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check:secrets` | Fails if secrets or Plaud data are tracked by git |
| `npm run hooks:install` | Installs the secret check as a pre-commit hook |

## Roadmap
- Share import: `docs/PRD-SHARE-IMPORT.md` §9. Done through **S2** — fetch,
  archive and upload. Next: run the upload against live Plaud, then a local web
  UI so a link can be pasted rather than typed into a terminal.
- Migration: `docs/PRD.md` §9. The upload flow discovered here is the same one
  M0 needed, so that gate is now answerable.

Still open on both: attaching an original transcript to an uploaded recording.
No endpoint for it has been observed.

## Testing
`npm run demo` proves the whole pipeline on your own machine in 30 seconds,
without a Plaud account. See `docs/TESTING.md` for all three levels.

## Contributing
See `CONTRIBUTING.md`. Endpoint findings are the most useful contribution — as
paths and shapes, never as real ids or content.

## License
MIT — see `LICENSE`.
