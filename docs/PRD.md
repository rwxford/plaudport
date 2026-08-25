# PRD — Plaud Personal→Team Consolidation Tool ("PlaudPort")

**Status:** Draft v2 for review · **Owner:** Ross Weatherford (rwxford) · **Type:** Internal, local-first utility (macOS)

## 1. Summary
A local, single-user web application that runs on the owner's MacBook and talks
directly to Plaud's (unofficial) web API to (1) take a complete, verified
**backup/export** of all Plaud content, and (2) **migrate (copy)** recordings
from the **Personal** workspace into the **Team** workspace so company meeting
content is consolidated and reachable by the official Plaud MCP from Claude.

Rationale: Plaud offers no public general-purpose API, and the official MCP is
read-only (list/search recordings; read transcripts/summaries/action items). The
*write/import* half of a migration therefore has to be custom-built.

## 2. Goals / Non-goals
**Goals**
- G1. One reliable, resumable, auditable copy of Personal → Team (private-in-Team).
- G2. Full local backup of everything (audio + transcripts + summaries + metadata) before any migration.
- G3. **Transfer** original transcripts/summaries into Team (not just regenerate).
- G4. Filterable + repeatable; safe to re-run without duplicating.
- G5. Secure by default (OWASP Top Ten applied); audio never leaves the machine except to Plaud.

**Non-goals**
- N1. No auto-promotion into shared "Team files" (owner decides what to share).
- N2. No delete/move of Personal originals (copy-only, ever).
- N3. Not a general Plaud client, not multi-user, not a hosted service.
- N4. Not dependent on the official MCP for any step (self-contained).

## 3. Domain constraints (verified against Plaud docs/support, see References)
- Personal and Team workspaces are strictly separated; content never moves automatically.
- Only **audio** can be imported into a workspace; it transfers as a **copy**; the original stays in Personal.
- Transcripts and summaries do **not** transfer natively and must be regenerated in Team.
- Plaud's own recommended bulk path: bulk-export audio via MCP, bulk-import into Team on Plaud Web.
- In-Team personal content is **private by default**; sharing to the whole team is via the "Team files" folder.
- Auth: Google SSO users must first set a password on web.plaud.ai; session tokens are long-lived (~300 days) and refresh silently.
- The web API is **reverse-engineered/unofficial** and may change without notice.

## 4. Functional requirements

### Authentication
- FR1. Primary: **manual bearer-token paste** captured from web.plaud.ai (MFA-agnostic).
- FR2. Optional: **email+password** login with automatic token refresh (requires a password set on the SSO account).
- FR3. Detect Personal vs Team context; select source (Personal) and target (Team) per operation.

### Backup / Export (must run before migrate)
- FR4. Export all items from a chosen workspace: original audio, transcript(s), summary/notes, action items, tags, folders, timestamps, device, IDs → structured local folder + `manifest.json`/CSV.
- FR5. **Skip-if-current:** if a valid, complete, verified export already exists, do not re-export (configurable freshness window; forceable).
- FR6. Resumable (per-item state) and integrity-checked (size/duration/sha256 recorded).

### Migration (copy)
- FR7. Migrate = download original audio from Personal → import into Team as a **copy**, landing **private** to the owner.
- FR8. **Filters:** date range, tag, folder, device, explicit include/exclude; default "all Personal".
- FR9. **Idempotent + repeatable:** persistent **ledger** prevents re-importing an already-migrated item (key = `sha256(audio) + source_id`).
- FR10. **Dry-run mode:** show exactly what would be exported/migrated (counts, sizes), no writes.
- FR11. **Derived-data transfer (primary) + regenerate (opt-in):**
  - FR11a. Transfer the **original** transcript, summary, action items from backup onto the migrated Team item (faithful preservation).
  - FR11b. Write path, validated in M0, in order of preference:
    1. Native field write if the web API accepts setting transcript/summary/note fields on an imported item.
    2. Else attach as a **note / markdown sidecar** on the Team item.
    3. Else store a companion document co-located with the audio.
  - FR11c. Regeneration is **opt-in**, offered as an additional fresh transcript/summary — never a replacement for the transferred original.
  - FR11d. Fidelity report per item: which write path succeeded; original == transferred?

### Verification & audit
- FR12. Post-migration **reconciliation report**: per-item source→target mapping, integrity match, status, regeneration state; CSV/JSON export.
- FR13. Every run writes a structured, timestamped **audit log** (no secrets).

### UI (local web)
- FR14. Screens: Connect/Auth · Workspaces · Backup · Migrate (filters + dry-run) · Progress (live) · Reports/Ledger · Settings.
- FR15. Long-running jobs show live progress (per-item + aggregate); cancel/resume-able.

## 5. Non-functional requirements
- NFR1. **Portable / local-first:** `npm install && npm start` opens `http://127.0.0.1:<port>`; runs entirely on macOS, no cloud dependency.
- NFR2. **Resilience:** exponential backoff + jitter on 429/5xx; configurable concurrency; safe to Ctrl-C and resume.
- NFR3. **Performance:** streaming download/upload (no full-file-in-memory); GB-scale libraries, long recordings.
- NFR4. **Adaptability:** all reverse-engineered endpoints isolated behind one versioned client module.
- NFR5. **Data integrity:** never mutate/delete source; all writes are copy-only and guarded.

## 6. Architecture & stack
- **Runtime:** Node.js ≥ 20 LTS, single local process.
- **Backend:** Fastify API + in-process job runner (export/migrate queues); SSE for live progress.
- **Frontend:** React + Vite SPA served at localhost.
- **Persistence:** SQLite (`better-sqlite3`) for ledger/job state/manifests; audio+transcripts under `./data/`.
- **Plaud client:** thin isolated module — auth, list, download, import, write-derived, regenerate. All endpoint knowledge lives here.
- **Secrets:** macOS Keychain via `keytar` (fallback: AES-256-GCM encrypted local file). No secrets in SQLite or logs.

Repo layout: `packages/plaud-client`, `apps/server`, `apps/web`, `docs/`, `data/` (gitignored).

## 7. Data model (core)
- `items` — source_id, workspace, title, created_at, duration, size, sha256, tags[], folder, device, has_transcript, has_summary.
- `backups` — item_id, local_paths (audio/transcript/summary/meta), verified_at, integrity_status.
- `migrations` — item_id (source), target_id, fingerprint, status (`pending|uploaded|derived_written|regenerating|done|failed`), attempts, last_error, timestamps.
- `runs` — id, type (`export|migrate`), filters, dry_run, counts, started/finished, log_path.

Idempotency key = `sha256(audio) + source_id`.

## 8. Security — OWASP Top Ten (2021) mapping
- **A01 Broken Access Control:** bind `127.0.0.1` only; single-user; source workspace read-only in code; copy-only enforced.
- **A02 Cryptographic Failures:** token in Keychain / AES-256-GCM; TLS to Plaud; optional at-rest encryption for backups; secrets never logged. Repo is public: `.env` and `data/` gitignored, run reports redacted by default, and a tracked-secret check runs pre-commit and in CI.
- **A03 Injection:** parameterized SQLite; zod validation on all inputs/filters; safe filename handling (no path traversal from Plaud titles).
- **A04 Insecure Design:** backup-before-migrate hard gate; dry-run default; copy-only invariant; documented threat model.
- **A05 Security Misconfiguration:** secure defaults (localhost bind, minimal CORS, no debug endpoints in prod build); secrets gitignored.
- **A06 Vulnerable/Outdated Components:** pinned deps, `npm audit`/Dependabot, minimal footprint; unofficial-client blast radius isolated.
- **A07 Identification & Auth Failures:** token rotation/refresh; explicit logout/purge; local UI gated by a generated session secret.
- **A08 Software & Data Integrity Failures:** verify downloaded audio (size+sha256+duration) before counting a backup valid; verify import before marking migrated; lockfile integrity in CI.
- **A09 Logging & Monitoring Failures:** structured audit logs with redaction; reconciliation reports; no secrets/PII-audio content in logs.
- **A10 SSRF:** outbound calls restricted to a Plaud host allowlist; no user-supplied URLs fetched.

## 9. Milestones
- **M0 – Spike/validation (read-only first):** confirm auth + list/download + **import** + **derived-data write** + optional regenerate. Gate below.
- **M1 – Backup/export:** full verified export + manifest + skip-if-current + resume.
- **M2 – Migration engine:** copy pipeline, ledger, idempotency, filters, dry-run.
- **M3 – Derived-data:** transfer originals onto Team items; opt-in regeneration.
- **M4 – Web UI + reports:** screens, live progress, reconciliation export.
- **M5 – Hardening:** OWASP pass, backoff tuning, runbook.

### M0 gate (O1 rule: pause & reassess)
M0 must validate three writes (read-only-safe first, then one throwaway test item):
1. Import audio into Team (private).
2. Write transcript + summary + action items onto that Team item (FR11b path 1 or 2).
3. Optional regenerate trigger.
If either (1) import or (2) derived-data write has no viable path, **stop and reassess** — no automatic browser-automation fallback without explicit approval.

## 10. Risks & mitigations
- Unofficial API changes → isolate in one module; version-tag; fast patch path.
- Import/derived-write may be UI-only → M0 proves early; per O1 we pause; documented worst-case fallback is Playwright automation (only with approval).
- Rate limits / large libraries → concurrency caps, backoff, resumability.
- Regeneration cost/time at scale → opt-in, batched; originals preserved regardless.
- ToS considerations → single-user, own-data-only; documented in README.

## 11. Assumptions & open questions
- Assumptions: one Personal + one Team workspace; token capturable from web.plaud.ai; macOS + Node ≥ 20; disk space for full audio backup.
- **O1 (M0):** does the web API expose usable import + derived-write, or is browser automation required? → resolve in M0, pause per decision.
- **O2:** backup layout default `data/backup/<workspace>/<YYYY>/<MM>/<id>-<slug>/`.
- **O3:** regeneration **opt-in** (decided).

## 12. Acceptance criteria
1. Verified full backup exists locally before any migration; re-running skips when current.
2. Filtered/full copy of Personal recordings appears **private** in Team; audio integrity verified; zero duplicates on re-run.
3. For each migrated recording, the **original** transcript/summary/action items are present on the Team copy (per fidelity report); regeneration only if enabled.
4. Reconciliation report + audit log produced each run.
5. Runs locally with one command; passes the OWASP checklist in §8.

## References
- Plaud Dev Platform / MCP docs: https://docs.plaud.ai/overview , https://docs.plaud.ai/plaud-mcp-cli/mcp
- API access status: https://support.plaud.ai/hc/en-us/articles/60726890231449
- Personal↔Team separation & move steps: https://support.plaud.ai/hc/en-us/articles/60074133589785 , https://support.plaud.ai/hc/en-us/articles/57744135157145
- Team files: https://www.plaud.ai/pages/plaud-release-notes
- Community toolkits (unofficial API patterns): https://github.com/sergivalverde/plaud-toolkit , https://github.com/jameshenning/plaudnotes
