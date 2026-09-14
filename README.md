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
**Share import:** working end to end, minus the upload. Plaud's share API turned
out to be unauthenticated, so one command retrieves a shared meeting's audio,
transcript, outline and summary — no HAR capture, no token. Still unproven:
writing it back into a Plaud workspace, so the mp3 is imported by hand for now.

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

Then import `audio.mp3` into Plaud by hand (Plaud Web → Personal → import audio).
Automating that last step is the one thing still unproven.

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
| `PLAUD_EXTRA_HEADERS` | no | — | JSON of extra headers, if your account needs them |
| `PLAUD_ALLOWED_HOSTS` | no | `web.plaud.ai,api.plaud.ai` | SSRF guard; `PLAUD_API_BASE` must match |
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
| `npm run fetch:audio -- --from-scan` | Download audio found by `scan:har` (fallback route) |
| `npm run scan:har -- <file.har>` | Derive the endpoint map from a DevTools HAR export (no token needed) |
| `npm run demo` | End-to-end self-test with a fake share page — no Plaud needed |
| `npm test` | Unit tests |
| `npm run spike` | M0 read-only probes → `data/spike-report.json` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check:secrets` | Fails if secrets or Plaud data are tracked by git |
| `npm run hooks:install` | Installs the secret check as a pre-commit hook |

## Roadmap
- Share import: `docs/PRD-SHARE-IMPORT.md` §9. Done through **S1b** — audio,
  transcript, outline and notes all archived locally. Next: attempt the upload
  into Personal.
- Migration: `docs/PRD.md` §9. Gate is **M0** (validate import + derived-data write).

Both hit the same unproven step — writing into a Plaud workspace. Per decision
O1, if that isn't possible via the API, we pause and reassess rather than
reaching for browser automation.

## Testing
`npm run demo` proves the whole pipeline on your own machine in 30 seconds,
without a Plaud account. See `docs/TESTING.md` for all three levels.

## Contributing
See `CONTRIBUTING.md`. Endpoint findings are the most useful contribution — as
paths and shapes, never as real ids or content.

## License
MIT — see `LICENSE`.
