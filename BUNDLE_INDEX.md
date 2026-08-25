# PlaudPort — Prep Bundle

Local-first tool to back up all Plaud data and consolidate **Personal → Team**
workspace recordings/transcripts (company meetings) so they're reachable by the
Plaud MCP from Claude.

## Contents
| File | Purpose |
|---|---|
| `docs/PRD.md` | Product Requirements (v2) |
| `README.md` | Project overview + local run |
| `docs/ENDPOINTS.md` | How to capture the unofficial Plaud web API (M0 prerequisite) |
| `.gitignore` | ignore secrets, data, node_modules |
| `.env.example` | config template (no secrets) |
| `package.json` / `tsconfig.json` | TS project |
| `src/*` | M0 read-only spike (run locally on your Mac) |

## Order of operations
1. Capture the Plaud web API base URL + token and fill `docs/ENDPOINTS.md`.
2. Run the M0 spike locally against your own account.
3. Clear the O1 gate (import + derived-data write validated) before building M1+.
