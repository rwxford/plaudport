# PlaudPort — Prep Bundle

Local-first tool to back up all Plaud data and consolidate **Personal → Team**
workspace recordings/transcripts so they're reachable by the Plaud MCP from Claude.

## Contents
| File | Purpose |
|---|---|
| `README.md` | Project overview, configuration table, local run |
| `docs/PRD.md` | Product Requirements (v2) |
| `docs/ENDPOINTS.md` | How to capture the unofficial Plaud web API (M0 prerequisite) |
| `SECURITY.md` | What must never enter this public repo; token handling |
| `CONTRIBUTING.md` | Setup, ground rules, how to share endpoint findings |
| `.env.example` | Config template (no secrets) |
| `.gitignore` | Ignores secrets, recordings, ledger, reports, `node_modules` |
| `scripts/check-no-secrets.sh` | Fails if secrets or Plaud data are tracked |
| `scripts/install-hooks.sh` | Installs that check as a pre-commit hook |
| `.github/workflows/ci.yml` | CI: typecheck + secret/data check |
| `package.json` / `tsconfig.json` | TS project |
| `src/*` | M0 read-only spike (run locally on your Mac) |

## Order of operations
1. Capture the Plaud web API base URL + token and fill `docs/ENDPOINTS.md`.
2. Run the M0 spike locally against your own account.
3. Clear the O1 gate (import + derived-data write validated) before building M1+.
