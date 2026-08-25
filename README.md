# PlaudPort

Local-first, single-user tool (macOS) to **back up** all your Plaud data and
**consolidate** company-meeting recordings/transcripts from your **Personal**
Plaud workspace into your **Team** workspace, so they're reachable by the Plaud
MCP from Claude.

## Status
Pre-M0. Not yet functional. This repo currently contains the PRD and a
**read-only spike** to validate Plaud's unofficial web API.

## Why this exists
- Plaud has no public general-purpose API.
- The official Plaud MCP is **read-only** — it can't import or write.
- Personal and Team workspaces are walled off; only audio imports natively, and
  transcripts/summaries don't carry over. This tool fills those gaps.

## Safety model
- **Copy-only.** Never deletes or moves Personal originals.
- **Backup-before-migrate.** Migration is blocked until a verified backup exists.
- **Local-only.** Binds to `127.0.0.1`; audio never leaves your Mac except to Plaud.
- **Secrets** live in macOS Keychain, never in the repo or logs.
- Uses an **unofficial, reverse-engineered API** that may break without notice.

## Requirements
- macOS, Node.js ≥ 20
- A Plaud account with Personal + Team workspaces
- A bearer token captured from web.plaud.ai (see `docs/ENDPOINTS.md`)

## Quick start (spike only)
```bash
npm install
cp .env.example .env       # then fill PLAUD_API_BASE + PLAUD_TOKEN
npm run spike              # read-only probes; writes spike-report.json
```

## Roadmap
See `docs/PRD.md` §9. Current gate: **M0** (validate import + derived-data write).
Per decision O1, if those writes aren't possible via the API, we pause and reassess.
