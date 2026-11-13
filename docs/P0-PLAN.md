# P0 Plan — Pull

**Milestone:** P0 of `PRD-PIPELINE.md` · **Status:** v4 — approved, **implemented**
(2026-11-10; deviations found while building are in §12; live gate in
`P0-GATE.md`, pending) · was: **approved for
implementation** (independent review, Codex, of `1722e92`; four review cycles,
`fa7bd06`→`1722e92`, plus a working-agent read); two nonblocking wording
cleanups (P0-D5, T10) applied after approval, 2026-11-09 · **Implements:** FR1, FR1a–d, FR2 (interface +
`plaud-mcp` adapter), FR3, FR14, FR14a–c, FR21 (partial), FR22 (partial) ·
**Does not touch:** anything in P1+ (no transcription, diarization, biometric
store, summaries, publishers, MCP server).

This plan was written in a planning-only session. No code was changed. Per
`CLAUDE.md`, implementation starts in a fresh session after this plan is
reviewed and approved. v2 answers a request-changes review; it is not yet
approved and goes back for a fresh independent review before any code.

## 0. Review response (v1 → v2)

Two independent reviews of v1 (`fa7bd06`): **Codex** returned request-changes
with findings C1–C6; a **working-agent read** added W1–W3. Each is resolved
below; the spec clarifications they drive land in `PRD-PIPELINE.md` (v7) in the
same PR, per the living-spec rule.

| # | Finding (class) | Resolution | Where |
|---|---|---|---|
| C1 | **[P1]** Ledger not rebuildable: discovery writes only SQLite before any download, so a crash/rebuild can erase pending ids that have no manifest (possibly outside the next window); and `runs`/`defects`/history have no archive form despite the identical-dump test. | **Manifest-first discovery.** A durable `manifest.json` + `rev-0001/meta.json` is written for every id **before** any network download (§6, §7 step 2). `index rebuild` is scoped to the `recordings` state and to `sync_lag_samples` (reconstructed from `first_seen_at`, now persisted in `meta.json`); `runs` and `defects` are observational run-history, explicitly **not** reproduced. Tests add rebuild-after-discovery and rebuild-after-failed-download. | §3, §6, §7, §8 (T2,T3,T7), §9 (G7) |
| C2 | **[P1]** Partial Plaud text becomes permanently "complete": `text_ok` on the first of {utterance, note}; staggered artifacts are then never collected. | **Per-artifact readiness** (transcript / polish / outline / highlights / note), each `pending → present | absent`. The bundle keeps being re-checked while any class is pending and the bundle has not aged out; each new arrival writes a new revision. | §3, §4, §7, §8 (T7) |
| C3 | **[P1]** Concurrent writers can corrupt the revision lifecycle: shared temp names, no lock → duplicate revision numbers, and one writer's cleanup deleting another's uncommitted revision. | **Archive-level exclusive writer lock** for every mutating op (pull / reconcile / rebuild / cleanup). Revision-number allocation and `*.tmp` cleanup happen only under the lock; stale-lock recovery is defined. Interleaved-writer test. | §2 (P0-D8), §6, §8 (T2) |
| C4 | **[P1]** Crash-safety omits directory durability: the revision dir is fsynced before rename, but not the recording dir after the revision and manifest renames; nested artifact dirs and audio durability are unspecified. | **Full fsync ordering**: every file, each nested subdir, the revision dir, then the **recording dir after each rename** (revision and manifest), and audio before the manifest that references it. Process-crash vs power-loss guarantees stated separately. | §6, §8 (T2) |
| C5 | **[P2]** G3 forces an artificial URL age (proves proactive refresh), but the PRD requires a URL *deliberately allowed to expire*. | Keep the override as the **automated** check (a); add a **live** check (b) that retains a real URL past expiry, observes the 403 rejection, then confirms refresh + successful download. | §9 (G3) |
| C6 | **[P2]** The exit checklist can pass with no audio on disk (G1 is a dry run; defects = 0 and ledger-equality say nothing about downloads); and G2's `--since` has no upper bound. | Add **G1c**: a mandatory real backfill with audio **count + hash** verification. `pull` gains **`--until`** so a single dense day compares to the web count. | §7, §9 (G1c, G2), §8 (T7) |
| W1 | `npx -y @plaud-ai/mcp@<pinned>` on every (hourly, unattended) run adds a resolve/network round-trip and fails offline. | **Pin-install once** into a managed location; the adapter execs the resolved entry directly; `doctor` verifies installed vs. pinned version. No per-run `npx` resolution. | §2 (P0-D1), §5 |
| W2 | `better-sqlite3` is the project's first native dependency and meets the just-merged Homebrew install. | Noted: `npm ci` builds/fetches it per-arch under Homebrew's pinned Node (same class as `tsx`/`esbuild`); `doctor` checks the native build. | §2 (P0-D7), §8 (T10), §10 (R6) |
| W3 | The default archive root holds a content-bearing ledger (real titles); and a bare first `pull` only reaches back `OVERLAP_DAYS`. | Default archive root is **gitignored** (T1); README's "Pull your library" notes the first-run window and backfill via `--all`/`--since`. | §8 (T1), §11 |

### Review response (v2 → v3)

A second Codex review of v2 (`d7229f5`) kept request-changes with four residual
P1 gaps (R2-1…R2-4) and a consistency cleanup. Resolutions:

| # | Finding | Resolution | Where |
|---|---|---|---|
| R2-1 | **[P1]** An old-but-alive lock can be stolen (age-based takeover restores C3). | Lock becomes a **renewed lease with fencing**: the holder heartbeats `renewedAt` and stamps an `epoch`; a lock is stealable only when its pid is provably dead on this host **or** its lease (`renewedAt`) has expired — **never on `startedAt` age**, so a long legitimate backfill that keeps renewing is never stolen. Takeover bumps the `epoch`; every write re-checks it still holds the current epoch and **aborts if fenced out**, so a suspended process that wakes cannot write under a stolen lock. | P0-D8, §6, T2a, PRD FR14b |
| R2-2 | **[P1]** Aged-out bundles are excluded from selection before their artifacts can flip to `absent`, so a bundle that crosses the timeout between runs stays `pending` forever. | Step 4 now selects **every `pending` bundle regardless of age**; overdue artifacts resolve to `absent` **without fetching**, those still within the timeout are fetched. | §4, §7 step 4, T7 |
| R2-3 | **[P1]** Manifest-first discovery has no recovery from a stale ledger: a crash after the manifest commit but before the UPSERT makes the next pull re-initialize the id. | Discovery write is **idempotent and manifest-authoritative**: if a recording dir/manifest already exists it is **adopted** (ledger reconciled from the manifest), never re-initialized; a startup per-recording reconcile makes the manifest win over any stale/older ledger row. | §7 step 2, T7 |
| R2-4 | **[P1]** Initial discovery fsyncs the recording dir but not the newly-created `<YYYY>/<MM>` parents, so power loss can lose the path. | The protocol now **fsyncs each newly-created directory up through the nearest pre-existing archive ancestor**; the ordering test covers it. Reflected in FR14b. | §6, T2, PRD FR14b |
| cleanup | G7/T11 still said "identical whole-ledger dump" while §3 limits equality to derived tables. | G7 and T11 now compare the **derived tables only**. | §8 (T11), §9 (G7) |

### Review response (v3 → v4)

A third Codex review of v3 (`9fb9f04`) kept two P1 blockers; the rest were
confirmed addressed. Resolutions:

| # | Finding | Resolution | Where |
|---|---|---|---|
| R3-1 | **[P1]** The fence is check-then-write (TOCTOU): writer A passes the epoch check, suspends, loses its lease to B, resumes and overwrites B's manifest / deletes its revisions. | **Replace the user-space lease+fence with an OS-held exclusive advisory lock** that the kernel keeps held across suspension and releases only on process exit. There is no moment when two processes both hold it, so no check-then-act gap exists to race. Implemented on `better-sqlite3`'s POSIX locking (held `BEGIN EXCLUSIVE`). Test: a second acquirer is refused while the holder lives (incl. suspended); the lock frees only on exit; after a killed holder a new process acquires. | P0-D8, §6, T2a, PRD FR14b |
| R3-2 | **[P1]** Recovery misses an **interrupted initial discovery**: a crash after the recording dir is created but before the initial manifest is committed leaves a dir that is neither an init candidate (dir exists) nor adoptable (no manifest). | Add an explicit **interrupted-initialization** case, kept distinct from a *corrupt committed* manifest: a dir with **no committed `manifest.json`** is completed under the lock — from `rev-0001/meta.json` if that exists (no network), else re-initialized from the listing, else (empty dir) discarded. A startup sweep handles dirs outside the current window. | §6, §7 steps 0b/2, T7 |

## 1. Findings that shape the plan

Each finding is labelled with its evidence class (`CLAUDE.md` §3a): **(a)**
automated, **(b)** live-account, **(c)** calibration; or **(doc)** read from
Plaud's published package or docs.

| # | Finding | Class | Consequence |
|---|---|---|---|
| F1 | Plaud ships an official local MCP server, `@plaud-ai/mcp` (npm, v0.3.14 at time of writing). It is a thin client over `https://platform.plaud.ai/developer/api/open/third-party/files/…`, authenticated by OAuth (browser flow on port 8199) with a **refresh token**, stored in `~/.plaud/tokens-mcp.json`. | doc | **The daily Chrome-bearer problem does not apply to pulls.** The `plaud-mcp` adapter drives this server over stdio and inherits refresh. The Chrome extension stays only for the optional `push`. |
| F2 | `list_files(date_from, date_to, page, page_size)` **does page through a date-filtered set** on the owner's library: two consecutive pages of 50 returned 100 distinct recordings identical to the unfiltered first 100. The docs page saying "page/page_size are ignored when filters are set" is wrong for the current build; the package's own tool description agrees with what was observed. | **(b)**, via the claude.ai Plaud connector | FR1a's design holds. **Pending:** repeat on the local `@plaud-ai/mcp` process (same backend, different build path) in gate check G1. |
| F3 | `query` (name substring) is client-side and scans only the newest 500 (5 pages × 100). | doc + (b) | Discovery never uses `query`. Date windows only. |
| F4 | Volume on the live library: 100 recordings in ~18 days (≈5–6/day); the library since mid-2025 is well over 500. | (b) | `--reconcile` must page the whole library; a > 500 library for gate G1 exists. |
| F5 | **Late sync observed:** in a sample of 100, one recording's `created_at` is **8 days** after its `start_at` (it also arrived with a raw-timestamp name, i.e. without Plaud's AI title). Two others arrived next-day. | (b) | Confirms FR1a. The 14-day default overlap is adequate but not generous; §13 calibration installed in P0 (§7 below). |
| F6 | The date filter applies to the recording's display date (`start_at`), inclusive, in the server's timezone; a dense-day query returned items whose `start_at` fell on that date in UTC-ish terms, including two titled for the previous local day. | (b) | Overlap window is expressed on `start_at`, which is what makes it catch late syncs (F5). Window arithmetic uses UTC dates with one extra day of slack on each edge. |
| F7 | `serial_number` is `null` on all 100 sampled recordings. | (b) | Cannot distinguish device vs. desktop-app recordings in P0; recorded as a field, not relied on. |
| F8 | `list_files` items carry `id`, `name`, `created_at`, `start_at`, `duration`; `get_file` adds `presigned_url` (24 h), `source_list`, `note_list`; `get_transcript` is paginated by cursor and has blocks `transaction`, `transaction_polish`, `outline`, `mark_memo`; `get_note` returns the AI summary. Minimum `page_size` is 10 (422 below). | doc + (b) | Ledger schema §3 and adapter interface §5 follow these shapes exactly. |
| F9 | The package sends PostHog telemetry unless `PLAUD_TELEMETRY_DISABLED` is set. | doc | The adapter always sets it. Noted in README. |
| F10 | Plaud's developer site describes two offerings only: "Plaud Embedded" (device SDK for products) and "MCP & CLI" (personal data access). No self-service OAuth client registration for the REST API is documented. | doc | Calling the REST API directly with Plaud's own client id would piggyback on their OAuth client. **Not done.** MCP over stdio is the supported path; the adapter interface keeps a direct-REST adapter possible later if Plaud opens registration. |

## 2. Decisions

| # | Decision | Reasoning |
|---|---|---|
| P0-D1 | `plaud-mcp` adapter = exec a **pin-installed** `@plaud-ai/mcp@<pinned>` as a stdio MCP server; talk to it with `@modelcontextprotocol/sdk` `Client`. The package is installed once into a managed location (`<ApplicationSupport>/PlaudPort/mcp/`, or an opt-in repo-local `node_modules` entry) and the adapter execs its resolved bin directly. **Not `npx -y` per run** (W1): hourly unattended runs must not depend on a network resolve, and an offline/flaky moment must not fail a pull. `doctor` reports installed-vs-pinned drift and re-installs on request. | F1, F10, W1. Official, refresh-capable, no reverse engineering, no per-run resolution. |
| P0-D2 | Login is the owner's job, once: `plaudport doctor` detects a missing/expired `~/.plaud/tokens-mcp.json` and tells the owner to run `plaudport login`, which calls the pinned package's **own `login` MCP tool**: Plaud's code runs the browser OAuth and stores the refresh token. PlaudPort never drives the OAuth flow itself and never sees, stores or refreshes a token. *(Amended 2026-11-13, owner-approved: the originally named `npx @plaud-ai/mcp login` does not exist in the pinned package — §12 I1. The package's `install` command was rejected because it also rewrites AI-client configs.)* | Keeps PlaudPort out of the credential-acquisition business; the refresh token then carries unattended runs. |
| P0-D3 | Ledger = SQLite (`better-sqlite3`), one file under the archive root (`<archive-root>/.plaudport/ledger.sqlite`), **derived and rebuildable** from manifests (FR14c). | PRD §7. Co-locating with the archive means a moved archive brings its ledger. |
| P0-D4 | The new archive (FR14) is a **new tree**, `<archive-root>/<YYYY>/<MM>/<id>/`, separate from the v1 `data/shares/` and `data/imports/` trees. v1 trees are left untouched in P0; a one-way `plaudport migrate-v1` is a P3 question, recorded in §9. | Avoids two live formats in one tree while keeping v1 commands working. |
| P0-D5 | P0 already produces **several revisions per recording**: `rev-0001/` holds `meta.json` at discovery (no Plaud text yet), and each Plaud artifact that arrives later (transcript, note, …) adds a further revision carrying the artifacts known so far; `audio.mp3` is written once at the recording root and referenced by all revisions. The full revision/manifest machinery (FR14b) is therefore exercised for real in P0 — `current` + `history`, trimming, fallback — not merely built ahead of P1. | The atomicity contract is load-bearing from the first milestone, so it is tested under real multi-revision writes now. |
| P0-D6 | No web UI changes in P0. CLI only. | Scope. |
| P0-D7 | New dependencies: `better-sqlite3` (ledger), `@modelcontextprotocol/sdk` (MCP client). `@plaud-ai/mcp` is **not** a runtime dependency; it is pin-installed and exec'd (P0-D1) so Plaud's updates do not silently change behaviour. | Minimal footprint, pinned. **`better-sqlite3` is the repo's first native dependency** (W2): under the Homebrew formula now on `main`, `npm ci` builds or fetches a prebuilt binary matching Homebrew's pinned Node ABI, the same per-arch install class as `tsx`/`esbuild`; `doctor` verifies the native build (T10, R6). |
| P0-D8 | **One OS-held exclusive advisory lock** (`<archive-root>/.plaudport/lock`) guards every mutating operation — `pull`, `reconcile`, `index rebuild`, and the cleanup pass. The lock is a kernel-held advisory lock acquired on an fd that stays open for the whole run; the **OS keeps it held while the process is merely suspended** and **releases it on process exit** (clean, crash, or kill). There is therefore **no moment when two processes both hold it** — the C3/R2-1 heartbeat-lease-and-fence is removed because the kernel, not our timers, decides liveness, and a check-then-write TOCTOU (R3-1) cannot arise: holding the lock *is* the write permission, not a value we re-read. Acquire is **non-blocking**: a contender finds the lock held and exits 3 ("archive busy"); it never steals it on age or on any heuristic. A leftover lock *file* after a crash is harmless — the OS already released the lock, so the next run acquires it even though the file exists; the file's `{pid, host, startedAt}` contents are informational only (for `doctor`/`report`), never used to infer staleness. **Substrate:** reuse `better-sqlite3` (already a dependency) — hold a `BEGIN EXCLUSIVE` transaction on a dedicated `.plaudport/lock.sqlite` for the run (SQLite uses POSIX `fcntl` advisory locks, which are process-associated and auto-released on termination); keep that one connection open and open the lock file nowhere else (POSIX-lock footgun). `flock(2)` via a native binding is the equivalent alternative if we ever drop SQLite. **Assumption:** writes run on a single Mac (the scheduler's); the archive volume may be external, but advisory locks are only relied on within one host, which matches the single-writer model. | C3, R2-1, R3-1. For a local single-user tool an OS lock is simpler and strictly safer than any user-space lease: liveness is the kernel's, suspension holds, exit releases, and there is no check-then-act gap to race. |
| P0-D9 | **The archive, not the ledger, is the durable record, and it is written manifest-first.** On first sight of an id, `pull` writes `rev-0001/meta.json` and a `manifest.json` (states `audio_pending`, all Plaud-text artifacts `pending`) **before any download**. The SQLite ledger is a derived index rebuilt from manifests (FR14c). Plaud's derived text is tracked **per artifact**, and each artifact that later arrives is written as a new immutable revision. | C1, C2. A durable per-id record before network work means a crash cannot lose a discovered id; per-artifact readiness means a transcript arriving before its note does not freeze the bundle "complete." |

## 3. Ledger schema (SQLite)

Derived from manifests; `plaudport index rebuild` recreates it from scratch.

```sql
CREATE TABLE recordings (
  id            TEXT PRIMARY KEY,          -- Plaud file id, `of_` form
  start_at      TEXT NOT NULL,             -- ISO 8601 from list_files
  created_at    TEXT NOT NULL,             -- ISO 8601 from list_files (sync time)
  duration_ms   INTEGER,
  name          TEXT,                      -- Plaud's title; archive-only, redacted in logs
  serial_number TEXT,                      -- observed null (F7); kept for later
  first_seen_at TEXT NOT NULL,             -- when PlaudPort first listed it
  last_seen_at  TEXT NOT NULL,
  dir           TEXT NOT NULL,             -- relative path under archive root
  audio_state   TEXT NOT NULL CHECK (audio_state IN
                  ('audio_pending','audio_ok','audio_failed')),
  audio_sha256  TEXT, audio_bytes INTEGER,
  audio_attempts INTEGER NOT NULL DEFAULT 0,
  audio_last_error TEXT,                   -- shape/class only, never a URL
  audio_next_retry_at TEXT,
  -- Bundle state is DERIVED from recording_artifacts (below): `plaud_text_ok`
  -- once every artifact is present-or-absent; `plaud_text_absent` only if all
  -- are absent at age-out; else `plaud_text_pending`. Stored for fast filtering,
  -- recomputed on rebuild.
  text_bundle_state TEXT NOT NULL CHECK (text_bundle_state IN
                  ('plaud_text_pending','plaud_text_ok','plaud_text_absent')),
  text_pending_since TEXT,
  manifest_rev  TEXT                       -- current revision id from manifest.json
);
CREATE INDEX recordings_start_at ON recordings(start_at);
CREATE INDEX recordings_states   ON recordings(audio_state, text_bundle_state);

CREATE TABLE recording_artifacts (         -- C2: per-artifact Plaud-text readiness
  recording_id TEXT NOT NULL,
  artifact     TEXT NOT NULL CHECK (artifact IN
                  ('transcript','polish','outline','highlights','note')),
  state        TEXT NOT NULL CHECK (state IN ('pending','present','absent')),
  last_checked_at TEXT,
  present_rev  TEXT,                        -- revision that first carried it, if present
  PRIMARY KEY (recording_id, artifact)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,  -- 'pull' | 'reconcile' | 'rebuild'
  started_at TEXT NOT NULL, finished_at TEXT,
  window_from TEXT, window_to TEXT,
  listed INTEGER, new_ids INTEGER, audio_ok INTEGER, audio_failed INTEGER,
  text_resolved INTEGER, defects INTEGER, report_path TEXT
);

CREATE TABLE defects (                      -- FR1d: in Plaud, not in ledger
  run_id TEXT NOT NULL, id TEXT NOT NULL, start_at TEXT, created_at TEXT,
  noted_at TEXT NOT NULL, PRIMARY KEY (run_id, id)
);

CREATE TABLE sync_lag_samples (             -- §13 calibration for overlap window
  id TEXT PRIMARY KEY, start_at TEXT NOT NULL, created_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL, lag_hours REAL NOT NULL
);
```

`meta.json` in each revision carries the same recording fields plus the raw
`list_files` item and `get_file` metadata (minus `presigned_url`), **and the
PlaudPort observations needed to rebuild deterministically**: `first_seen_at`,
`last_seen_at`, the audio state + attempt count + last-error class, and the
per-artifact readiness map (C1, C2). So a rebuild needs nothing outside the
archive.

**What `index rebuild` reproduces, exactly (FR14c).** From manifests + `meta.json`
alone it reconstructs the `recordings` rows, the `recording_artifacts` rows, and
the `sync_lag_samples` rows (lag is `first_seen_at − start_at`, both persisted).
It does **not** reproduce `runs` or `defects`: those are observational
run-history, not derived from any recording's content, and are retained only in
the live ledger (lost on a from-scratch rebuild, which is acceptable and
documented). The identical-dump test (T3) and gate G7 therefore compare the
**derived tables only** (`recordings`, `recording_artifacts`, `sync_lag_samples`),
not `runs`/`defects`. Retry counters (`audio_attempts`, `audio_next_retry_at`)
are persisted in `meta.json` so a rebuild is faithful; even if a rebuild reset
them, re-deriving `audio_pending` is safe because downloads are idempotent.

## 4. State machines (FR1b, FR1c)

**Audio** (per recording):

```
discovered ──▶ audio_pending ──download ok, sha256 recorded──▶ audio_ok
                   │  ▲
                   │  └── retry when now ≥ audio_next_retry_at
                   └──download error──▶ audio_failed (attempts++, next_retry_at = backoff)
```

- **`discovered` is durable before download (C1).** On first sight, `pull`
  writes `rev-0001/meta.json` + `manifest.json` (states as above) under the
  writer lock (§6, §7 step 2) *before* the id enters `audio_pending`. A crash
  between discovery and download leaves a complete, rebuildable record on disk,
  never a ledger-only id that a rebuild would erase.
- Backoff: `min(2^attempts × 15 min, 24 h)`, jittered ±20%. Never gives up;
  `report` lists items with `attempts ≥ PLAUDPORT_RETRY_REPORT_AFTER` (default 3).
- **Expired presigned URL** (HTTP 403 on the S3 fetch after the 24 h window,
  or a URL older than 23 h at download start): re-call `get_file` for a fresh
  URL and continue; this is *not* an attempt and does not move the state.
  Only a failure with a fresh URL counts.
- A download writes to `audio.mp3.part`, verifies length against
  `Content-Length` when present, computes sha256, then renames. A `.part` left
  behind is resumed-from-zero (presigned S3 GETs support `Range`, but P0 keeps
  it simple: restart; revisit if large files prove slow).

**Plaud text — per artifact, not per recording (C2).** Plaud produces up to five
derived artifacts asynchronously and independently: `transcript`
(`transaction`), `polish` (`transaction_polish`), `outline`, `highlights`
(`mark_memo`), `note` (the AI summary). Each has its own machine:

```
pending ──artifact has non-empty content──▶ present
   │
   └── now − text_pending_since > PLAUDPORT_PLAUD_TEXT_TIMEOUT_DAYS ──▶ absent
```

- **Every pull re-checks every artifact still `pending`** for a recording whose
  bundle has not aged out — not "pending ids" as a whole. A transcript arriving
  before its note (or a note before its transcript) can no longer freeze the
  rest "complete"; each still-pending artifact keeps being fetched until it is
  `present` or the bundle ages out. One `get_transcript` call returns
  `transaction`/`transaction_polish`/`outline`/`mark_memo` together, so checking
  those four is one call; `note` is `get_note`.
- **Each newly-`present` artifact is written as a new immutable revision** (§6)
  carrying the artifacts known so far, so late arrivals accrete without
  rewriting an existing revision.
- **"Content"** is per artifact: `transcript` present = ≥ 1 `transaction`
  utterance; `note` present = non-empty note; `outline`/`highlights`/`polish`
  present = a non-empty block. `highlights`/`mark_memo` is still fetched with the
  transcript (FR3) and an empty result is a legitimate `absent`, not pending.
- **Bundle state** (`recordings.text_bundle_state`, derived): `plaud_text_ok`
  once all five are present-or-absent; `plaud_text_absent` only if all five
  aged out to absent; else `plaud_text_pending`. Checks are capped per run
  (`PLAUDPORT_TEXT_CHECKS_PER_RUN`, default 200 recordings) so a backlog cannot
  starve discovery, oldest `text_pending_since` first. A bundle that crosses the
  timeout between runs is still selected (§7 step 4 selects every `pending`
  bundle **regardless of age**); its overdue artifacts resolve to `absent`
  **without a fetch**, so it resolves instead of stalling `pending` forever (R2-2).
- An aged-out artifact is terminal for automation but `pull --recheck-text <id>`
  (or `--recheck-text --all`) reopens the recording's still-`absent` artifacts
  (Plaud transcribes late when minutes refresh at the month boundary — expected
  once the plan drops to Starter).

All machines are pure functions over `(state, event, now, config)` in
`src/pull/states.ts`, unit-tested exhaustively without I/O.

## 5. Source adapter interface (FR2)

```ts
// src/sources/types.ts
export interface RecordingSummary {
  id: string; name: string | null; startAt: string; createdAt: string;
  durationMs: number | null; serialNumber: string | null;
}
export interface RecordingDetail extends RecordingSummary {
  audioUrl: string | null;      // presigned; never persisted, never logged
  audioUrlIssuedAt: string;     // to apply the 23 h freshness rule
  raw: unknown;                 // get_file minus presigned_url, for meta.json
}
export interface TranscriptBlock { block: "transaction"|"transaction_polish"|"outline"|"mark_memo"; items: unknown[]; }
export interface PlaudText { transcript: TranscriptBlock[]; note: unknown | null; }

export interface RecordingSource {
  readonly name: "plaud-mcp" | "plaud-web" | "file" | "share";
  list(window: { from: string; to: string }, page: { page: number; pageSize: number }): Promise<RecordingSummary[]>;
  detail(id: string): Promise<RecordingDetail>;
  text(id: string): Promise<PlaudText>;         // all blocks, all cursor pages
  health(): Promise<{ ok: boolean; note: string }>;   // auth state, version
}
```

- `src/sources/plaudMcp.ts`: spawns the pinned package with
  `PLAUD_TELEMETRY_DISABLED=1`, connects with the SDK `StdioClientTransport`,
  calls tools, parses the JSON text content block, validates with zod schemas
  derived from F8. One process per `pull` run; closed on exit. Any tool error
  containing an auth/refresh signature maps to a single `AuthError` whose
  message is the `doctor` instruction (P0-D2).
- `src/sources/plaudWeb.ts`: wraps the existing `PlaudClient`; **P0 ships it
  as a stub that throws `NotImplemented` with a pointer to the issue**, because
  the only reason to build it is an MCP outage, which has not happened. Keeping
  the interface honest matters more than a second code path nobody has tested.
- `file` and `share` are not reworked in P0; the interface is designed so they
  can be adapted later without changing `pull`.

## 6. Archive layout and manifest contract (FR14, FR14a–c)

```
<PLAUDPORT_ARCHIVE_ROOT>/
  .plaudport/ledger.sqlite            # derived
  <YYYY>/<MM>/<id>/                   # YYYY/MM from start_at (UTC)
    audio.mp3                         # written once; sha256 in manifest
    manifest.json                     # the commit point
    rev-0001/
      meta.json                       # list_files + get_file (no URL), fetch times
      plaud/transcript.json           # transaction block, all pages
      plaud/transcript-polished.json  # transaction_polish
      plaud/outline.json
      plaud/highlights.json           # mark_memo (FR3), may be []
      plaud/note.json
    rev-0002/ …                       # P1+ add transcript/assignments/summaries
```

`manifest.json`:

```json
{
  "schema": 2, "id": "…", "startAt": "…", "createdAt": "…",
  "audio": { "file": "audio.mp3", "bytes": 0, "sha256": "…", "fetchedAt": "…" } | null,
  "current": { "rev": "rev-0001", "writtenAt": "…", "artifacts": { "meta.json": "<sha256>", "plaud/transcript.json": "<sha256>", … } },
  "history": [ { "rev": "…", "writtenAt": "…", "artifacts": { … } } ],
  "firstSeenAt": "…", "lastSeenAt": "…",
  "states": {
    "audio": { "state": "audio_ok", "attempts": 0, "lastErrorClass": null, "nextRetryAt": null },
    "textBundle": "plaud_text_ok", "textPendingSince": null,
    "artifacts": { "transcript": "present", "polish": "present", "outline": "present", "highlights": "absent", "note": "present" }
  }
}
```

At **discovery** (before any download) `audio` is `null`, `audio.state` is
`audio_pending`, every entry in `artifacts` is `pending`, and `current` points
at a `rev-0001` that contains only `meta.json`. This is the durable record C1
requires; audio and each Plaud artifact fill in on later runs, each as a new
revision (§4).

**Concurrency (C3, R2-1, R3-1).** Every mutating operation runs **while holding
the OS exclusive lock** (P0-D8). Because the kernel permits only one holder and
keeps it across suspension, there is only ever one live writer: revision numbers
cannot collide and cleanup cannot race another writer's uncommitted revision, and
there is no user-space check-then-write gap to lose a race on. The lock is
acquired before step 0 and released (by the OS) on exit; `index rebuild` and the
cleanup pass take it too.

Write protocol (FR14b), implemented once in `src/archive/revision.ts` and used
by every writer from P0 on. **`fsync` ordering is the crash-safety contract**;
step 0 is the manifest-first discovery write (C1), with explicit recovery for an
interrupted one (R3-2):

0. **Discovery write** (first sight of an id, before any download). Decide by the
   recording directory and its manifest:
   - **dir + committed, valid `manifest.json`** → *adopt* (R2-3): reconcile the
     ledger row from the manifest; do **not** re-initialize.
   - **dir + committed but *corrupt* manifest** → the read protocol's
     fallback/`corrupt` path (below), never re-init.
   - **dir + *no* committed manifest** → *interrupted initialization* (R3-2):
     complete it under the lock — from `rev-0001/meta.json` if present (no
     network), else re-initialize from the current listing item; an **empty** dir
     (crash before even `meta.json`) carries no information and is removed, to be
     re-created when the id is next listed.
   - **no dir** → *initialize*: create the `<YYYY>/<MM>/<id>` tree and, because
     those parents may be new, **`fsync` each newly-created directory up through
     the nearest pre-existing archive ancestor** (R2-4) so the path itself is
     durable; then write `rev-0001/meta.json`; `fsync` the file; `fsync`
     `rev-0001/`; `fsync` the recording directory; write the initial
     `manifest.json` (step 3). From here the id is durable.
1. Allocate `rev-NNNN` by reading existing `rev-*` under the lock. Create
   `rev-NNNN.tmp/`; write every artifact to a temp name and rename within the
   dir; `fsync` **each file**; `fsync` **each nested subdirectory** (e.g.
   `plaud/`) after its files; `fsync` `rev-NNNN.tmp`; rename it to `rev-NNNN`;
   then **`fsync` the recording directory** so the rename itself is durable.
2. Build the new manifest in memory: `current` ← new rev with per-artifact
   sha256; previous `current` prepended to `history`; `history` trimmed to
   `PLAUDPORT_REVISION_HISTORY` (default 3) in this same swap.
3. Write `manifest.json.tmp` in the recording dir; `fsync` it; rename over
   `manifest.json`; then **`fsync` the recording directory again**.
4. Under the lock, delete revision directories in neither `current` nor
   `history`, and any `*.tmp` dirs older than one hour.

**Audio durability.** `audio.mp3.part` is written, length-checked, sha256'd,
`fsync`ed, renamed to `audio.mp3`, and the **recording directory `fsync`ed**,
*before* the manifest swap that records the audio hash — so a verified
`audio.mp3` is never referenced by a manifest that isn't yet durable, and a
manifest never references audio that isn't on disk.

**Guarantee scope.** File `fsync` plus the rename makes a write durable against a
**process crash**; the directory `fsync`s above — including the newly-created
`<YYYY>/<MM>/<id>` parents at discovery (R2-4) — are what extend that to
**power loss**. The `revision.test.ts` harness injects process crashes (kill
between every step) and asserts reader behaviour; the power-loss guarantee rests
on the documented `fsync` ordering, which the tests check is *issued* (via a
spy) but cannot prove against real power loss. The plan states this rather than
calling the archive "crash-safe" unqualified.

Read protocol: load manifest; for `current`, verify every listed artifact
exists and hashes match; on mismatch fall back to the first `history` entry
that verifies and log a `manifest-mismatch` warning; if none verifies, the
recording is reported as **corrupt** and excluded from the index, never
silently repaired. **A recording directory with *no committed* `manifest.json`
is not "corrupt"** — it is an *interrupted initialization* (R3-2) and is handled
by discovery step 0, not here. "Corrupt" means a manifest that parses but whose
`current` and all `history` revisions fail hash verification.

`PLAUDPORT_ARCHIVE_ROOT` default: `./data/archive` (development). `doctor`
warns when the root is on the boot volume and no backup location
(`PLAUDPORT_BACKUP_HINT`, free text the owner sets to acknowledge they have
one) is configured (FR14a).

## 7. Discovery algorithm (FR1, FR1a, FR1d)

```
pull [--since D] [--until D] [--all] [--reconcile] [--recheck-text …] [--dry-run]
  0. acquire the OS archive lock (P0-D8); exit 3 "archive busy" if a live holder
     exists. (A leftover lock file from a crash is ignored — the OS already freed
     the lock.)
  0b. STARTUP RECONCILE (R2-3, R3-2): sweep recording dirs and reconcile each
     against the manifest, which is authority — (i) manifest newer than / absent
     from the ledger → re-derive the row from the manifest; (ii) dir with NO
     committed manifest → interrupted init (§6 step 0): complete from meta.json,
     or remove if empty. This sweep covers dirs outside this run's window.
  1. window.to   = --until ? (D + 1 day) : today(UTC) + 1 day
     window.from = --all ? EPOCH : --since ?? (max(start_at in ledger) − OVERLAP_DAYS − 1 day)
                    (first run with empty ledger: today − OVERLAP_DAYS; owner uses --since/--all to backfill)
  2. for page = 1..: list(window, {page, pageSize: 100}); stop when < 100 returned
     for each listed item, run the §6 step-0 decision (no dir → initialize; dir +
         valid manifest → adopt; dir + no committed manifest → complete the
         interrupted init; dir + corrupt manifest → read-protocol fallback). An
         initialize/complete writes rev-0001/meta.json + manifest (audio
         null/pending, all artifacts pending) BEFORE any download; then UPSERT the
         derived ledger row and record sync_lag_samples (lag = first_seen_at −
         start_at, and created_at − start_at). A fully-known item just updates
         last_seen_at.
         (--dry-run stops here: it lists and counts, writes nothing.)
  3. select audio_pending ∪ (audio_failed where next_retry_at ≤ now), oldest start_at first:
       detail(id) → download → verify length+sha256 → write audio.mp3 → manifest (audio)
  4. for EVERY recording whose bundle is still `plaud_text_pending` — regardless
     of age (R2-2) — cap TEXT_CHECKS_PER_RUN recordings, oldest text_pending_since
     first. Split its still-pending artifacts by the age-out deadline:
       - artifacts PAST the deadline → mark `absent` WITHOUT fetching;
       - artifacts WITHIN the deadline → text(id) → present (write a new rev with
         the artifacts known so far) | else touch last_checked_at.
       recompute text_bundle_state from the per-artifact rows (so a bundle that
       crossed the timeout between runs still resolves instead of stalling).
  5. write run row + report JSON (redacted: counts, states, error classes; no names/ids
     unless PLAUD_REDACT_SAMPLES=false); release the lock.
--reconcile: window = EPOCH..today+1; list everything; every id not in ledger →
  defects row + WARN "discovery defect" + DISCOVERY WRITE so the item is durable,
  then proceed as a normal pull so it is archived. Exit code 2 when defects > 0.
```

Rate limiting: sequential tool calls, 250 ms minimum spacing, exponential
backoff on 429/5xx (`PLAUD_REQUEST_TIMEOUT_MS` reused). Plaud publishes no
rate limits (F10), so P0 measures and `report` prints the request count and
429 count per run.

### §13 defaults P0 touches, and what P0 installs

| Default | P0 action | Class |
|---|---|---|
| Overlap window 14 d (`PLAUDPORT_PULL_OVERLAP_DAYS`) | `sync_lag_samples` table populated on every first sight; `plaudport report --lag` prints max/p95 lag in hours and the implied window (2× max). **Decision deferred** to P6 or 30 days of data, whichever first. F5 already shows 8 days in an 18-day sample. | installs (c) |
| Text age-out 7 d (`PLAUDPORT_PLAUD_TEXT_TIMEOUT_DAYS`) | `report` prints the distribution of `text_pending_since → resolved` durations. | installs (c) |
| Retry report threshold 3 (`PLAUDPORT_RETRY_REPORT_AFTER`) | `report` prints attempts histogram and error classes. | installs (c) |
| Revision history 3 (`PLAUDPORT_REVISION_HISTORY`) | Implemented; no data until P1+ writes revisions. | — |

## 8. Task list

Each task names the FR it satisfies, its test(s), and the evidence class the
test provides. Tasks are ordered; each is one or two commits.

| # | Task | FR | Proof | Class |
|---|---|---|---|---|
| T1 | Add `PLAUDPORT_ARCHIVE_ROOT`, `PLAUDPORT_PULL_OVERLAP_DAYS`, `PLAUDPORT_PLAUD_TEXT_TIMEOUT_DAYS`, `PLAUDPORT_RETRY_REPORT_AFTER`, `PLAUDPORT_TEXT_CHECKS_PER_RUN`, `PLAUDPORT_REVISION_HISTORY`, `PLAUDPORT_BACKUP_HINT`, `PLAUD_MCP_PACKAGE_VERSION` to `.env.example`, `config.ts` (zod), README/ADVANCED tables; **add the default archive root (`data/archive/`) to `.gitignore`** (W3). (No lock-timing config — the OS lock needs none, R3-1.) | FR14a, §13 | `config.test.ts`: defaults, bounds, rejects nonsense; a test asserts the archive glob is gitignored | a |
| T2 | `src/archive/revision.ts`: write/read protocol of §6 — idempotent discovery write (step 0), full `fsync` ordering, trim, cleanup, fallback, corrupt detection — **all under the OS archive lock (T2a)** | FR14b, C1, C4, R2-4 | `revision.test.ts`: crash injection between every step (temp dir left, manifest not swapped, artifact missing, hash mismatch) → reader behaviour exactly as §6; a spy asserts the `fsync` ordering (each file, nested dir, rev dir, **recording dir after each rename**, **each newly-created `<YYYY>/<MM>/<id>` parent up to a pre-existing ancestor**, audio before manifest) is issued; property test: N random write/crash sequences never lose a verified revision | a |
| T2a | `src/archive/lock.ts`: **OS-held exclusive archive lock** (P0-D8) on `better-sqlite3` (held `BEGIN EXCLUSIVE` on `.plaudport/lock.sqlite`), non-blocking acquire, released by the OS on process exit; writes an informational `{pid,host,startedAt}` | FR14b, C3, R2-1, R3-1 | `lock.test.ts` (spawns real child processes so the OS lock is exercised): two interleaved writers serialize (no duplicate `rev-NNNN`, no cleanup of an uncommitted revision); **a second acquirer is refused while the holder is alive, including when the holder is suspended (SIGSTOP) after acquiring** — it can never take over and double-write (R3-1); after the holder is **killed** a new process acquires; a leftover lock file alone does not block acquisition | a |
| T3 | `src/ledger/db.ts` + schema (incl. `recording_artifacts`) + `index rebuild` from manifests | FR14c, C1, C2 | `ledger.test.ts`: build from fixture archive, drop db, rebuild, **dump of the derived tables** (`recordings`, `recording_artifacts`, `sync_lag_samples`) is identical; `runs`/`defects` are not reproduced by design; **rebuild after discovery-only** (no audio yet) keeps the id; **rebuild after a failed download** keeps the `audio_failed` row; corrupt recording excluded and reported | a |
| T4 | `src/pull/states.ts` pure state machines + backoff | FR1b, FR1c, C2 | `states.test.ts`: audio transition table incl. expired-URL path is not an attempt, age-out boundary, backoff cap and jitter bounds; **per-artifact text machines**; bundle state derived from the five artifacts (ok only when all present-or-absent; absent only when all absent) | a |
| T5 | `src/sources/types.ts`, `src/sources/plaudMcp.ts` with zod response schemas | FR2, F8 | `plaudMcp.test.ts` against **fake MCP server** (T6): list paging, detail, text with cursor pages, auth error mapping, telemetry env set on spawn | a |
| T6 | `scripts/fake-plaud-mcp.mjs`: a stdio MCP server serving fixture recordings (synthetic audio, synthetic transcripts) with knobs: late-appearing recording, **each Plaud artifact appearing independently after its own N calls** (transcript before note, note before transcript, highlights empty), presigned URL that expires after T seconds, 429 on demand, > 500 recordings mode | FR1a–d, C2 test bed | used by T5, T7, T8; `demo.mjs` step 6 | a |
| T7 | `src/pull/pull.ts` + CLI `plaudport pull` per §7 (`--since`, `--until`, `--all`, `--dry-run`, `--recheck-text`) incl. startup reconcile (§7 step 0b) | FR1, FR1a–c, FR3, C1, C2, C6, R2-2, R2-3, R3-2 | `pull.test.ts` on fake server: late recording discovered by overlap; failed download retried next run; expired URL re-fetched without an attempt; **crashes injected at each init point — after the dir is created, after `meta.json`, after the manifest but before the ledger UPSERT — are each recovered by an ORDINARY pull** (not a rebuild): the manifest-committed case is adopted, the no-manifest case completes the interrupted init, the empty-dir case is re-created; no duplicate, no overwrite of a later revision (R2-3, R3-2); **a bundle first revisited AFTER its age-out deadline resolves to `absent` without stalling pending** (R2-2); **staggered artifacts are all eventually collected** (transcript then note each add a revision); `mark_memo` stored; `--dry-run` writes nothing; `--until` bounds the window to one day | a |
| T8 | `--reconcile` + `defects` + exit code 2 | FR1d | `pull.test.ts`: seed a recording directly into the fake server with a `start_at` older than the window → defect logged, then archived | a |
| T9 | `plaudport report [--lag]` and run JSON; redaction applied | FR22, §13 | `report.test.ts`: report contains no names/ids with redaction on; lag stats correct on fixtures | a |
| T10 | `plaudport doctor` (P0 subset): Node version, archive root + backup hint, `@plaud-ai/mcp` **installed at the pinned version** (reports installed-vs-pinned drift and offers re-install, W1), token file present and not expired (reads `expiresAt` only), `better-sqlite3` native build OK (W2), and **held-lock reporting** — whether the archive lock is currently held and by which pid/host, noting that a leftover lock *file* alone is harmless (the OS frees the lock on exit) and is never force-broken | FR21 | `doctor.test.ts` with injected environment, incl. a drifted version, a live held lock, and a harmless leftover lock file | a |
| T11 | Extend `scripts/demo.mjs`: step 6 runs T6 + `pull` twice (second run exercises retry + late sync), then `index rebuild`, asserts **derived-table** equality (`recordings`, `recording_artifacts`, `sync_lag_samples`; not `runs`/`defects`) | FR1, FR14c | `npm run demo` PASS | a |
| T12 | Docs: `docs/CLI.md`, `docs/ADVANCED.md` Scripts/Roadmap, README "Pull your library" section, `docs/BACKUP.md` stub noting FR14d is P5 | — | review | — |
| T13 | **Live gate run** (owner): §9 checklist, results recorded in `docs/P0-GATE.md` with counts only | FR1, §9 | — | **b** |
| T14 | PRD edits in the same PR: F2 resolves O1 (record the observed behaviour and that the docs page is wrong); §4 gains the `@plaud-ai/mcp` facts; **FR1b clarified to per-artifact Plaud-text readiness (C2); FR14b gains the writer lock + full power-loss `fsync` ordering (C3, C4); FR14c scopes "derived/rebuildable" to the recording state and names the observational tables (C1)**; changelog v7 | CLAUDE.md living-spec rule | review | — |

## 9. P0 exit gate — checklist

From PRD §9. Each line states its class, prerequisite, who runs it, and how
the result is recorded. Anything not run is recorded as **pending** in
`docs/P0-GATE.md`, never implied.

| # | Check | Class | Prerequisite | Runs | Evidence recorded |
|---|---|---|---|---|---|
| G1 | Full-library paging: `pull --all --dry-run` lists every recording; total equals the count shown in Plaud web (owner reads it off the UI) | b | owner logged in via `plaudport login`; library > 500 (F4) | owner | listed count, web count, pages fetched, 429 count |
| G1a | Same as G1 via the local package confirms F2 (filtered paging works) | b | as G1 | owner | page count and distinctness check from `report` |
| G1c | **Real backfill, not a dry run (C6):** after G1, `pull --all` actually downloads; then verify that **the count of `audio_ok` recordings equals the listed count** (minus any Plaud reports as audio-less) and that **sha256 re-verification of a random sample (≥ 20, or all if fewer) passes**. A run where downloads silently failed cannot pass this. | b (+ a on fake) | G1 done; disk + time (R3) | owner | audio_ok vs. listed, sample hashes re-verified |
| G2 | Dense day: `pull --since <day> --until <day> --dry-run` on a day with ≥ 10 recordings matches the web UI for that day. The `--until` bound is what makes the total comparable to one day (C6). | b | owner picks the day | owner | count vs. web count |
| G3 | Expired URL — **two checks.** (a, automated on the fake server) `PLAUDPORT_DEBUG_URL_AGE_HOURS=25` forces the freshness rule → re-fetch, `attempts` stays 0. (b, live) a **real** presigned URL is retained past its 24 h expiry, the S3 403 is observed, then `get_file` refreshes it and the download completes — the PRD's "deliberately allowed to expire" (C5). | a + b | one pending recording; (b) 24 h elapsed | owner | ledger row: state, attempts; for (b), the observed 403 then success |
| G4 | Transcript-less recording lands `plaud_text_pending` and later resolves | b | a recording Plaud has not yet transcribed (common within minutes of sync) | owner, two runs ≥ 10 min apart | state before/after |
| G5 | Late-synced recording discovered: owner records on the Note Pro with the phone app closed, syncs the next day, runs `pull`; recording appears with `created_at − start_at > 12 h` and inside the overlap window | b | Note Pro, one day | owner | lag hours from `report --lag` |
| G6 | `pull --reconcile` reports 0 defects after G1 | b | G1 done | owner | defects count |
| G7 | `index rebuild` after G1 reproduces the **derived tables** identically (`recordings`, `recording_artifacts`, `sync_lag_samples`; `runs`/`defects` are observational and excluded) — SQL dump diff of those tables | a + b | G1 done | owner | diff is empty |
| G8 | Every automated test (T2–T11) green in CI | a | — | CI | green check on the PR |

**Explicitly pending after P0, by design:** overlap-window and text-timeout
calibration (class c, §7); restore verification (FR14d, P5).

## 10. Risks and open questions specific to P0

- **R1. `@plaud-ai/mcp` changes shape.** Pinned version; zod schemas fail
  loudly; `doctor` reports available vs. pinned version. Plaud's `mcp.plaud.ai`
  remote endpoint is an alternative transport if the local package is ever
  withdrawn (the installer references it).
- **R2. Refresh token lifetime unknown.** If it expires (weeks? months?),
  unattended pulls stop with `AuthError` → macOS notification is P5; in P0
  the exit code and `doctor` are the signal. Record the first observed expiry
  in `P0-GATE.md`.
- **R3. Rate limits unknown.** Sequential calls with spacing; measure; a full
  `--all` on a 1,000+ library is ~1,000 `get_file` calls plus audio; expect it
  to take an hour or more the first time and say so in the README.
- **R4. Disk.** ~50 h/month of MP3 at Plaud's bitrate is roughly 2–3 GB/month.
  `doctor` prints free space at the archive root.
- **R5. Timezone edges.** Window arithmetic in UTC with a day of slack each
  side (F6) and the overlap window mean an off-by-one cannot lose a recording,
  only re-list it, which the upsert tolerates.
- **R6. First native dependency (W2).** `better-sqlite3` must build or fetch a
  prebuilt binary for the running Node ABI. Under the Homebrew formula (now on
  `main`), `npm ci` does this per-arch at install, the same class as
  `tsx`/`esbuild`; `doctor` (T10) fails loudly if the native build is missing.
  No prebuilt `node_modules` is ever shipped cross-platform.
- **R7. Writer-lock recovery (C3, R2-1, R3-1).** The lock is OS-held: a crashed
  or killed process has it released by the kernel on exit, so the next run
  acquires cleanly even though the lock *file* remains; a merely suspended
  process keeps the lock, so no one takes it over to double-write, and on resume
  it still holds it. There is no age heuristic and no user-space takeover to get
  wrong. The one assumption is single-host writes (P0-D8): advisory locks do not
  coordinate across machines, which the single-Mac pipeline does not require.
  `doctor` surfaces a held lock (pid/host) so a wedged run is visible, but never
  breaks it by force.
- **Q1 (for P3).** Migrate v1 `data/shares/` and `data/imports/` into the new
  tree? Those recordings have no Plaud id of their own (share imports do have
  the uploaded `of_` id); defer.
- **Q2 (for P1).** The transcript pager returns utterances with speaker labels
  from Plaud; P1's normalized transcript must keep Plaud's labels as
  `plaud/` provenance only, never as identity (FR8a).

## 11. What the owner should expect to run

```bash
npm install                              # adds better-sqlite3, @modelcontextprotocol/sdk
npm run doctor -- --install-mcp          # pin-installs @plaud-ai/mcp (P0-D1), then checks
npm run login                            # once; Plaud's own sign-in in the browser; tokens in ~/.plaud/
npm run doctor                           # all green before pulling
npm run pull -- --since 2026-10-15 --until 2026-10-15 --dry-run  # G2 one-day check, writes nothing
npm run pull -- --all                    # first full archive; long (R3)
npm run pull -- --reconcile              # G6
npm run report -- --lag                  # §13 calibration readout
```

A bare `npm run pull` (no `--since`/`--all`) only reaches back
`PLAUDPORT_PULL_OVERLAP_DAYS` (default 14); the **first** archive needs `--all`
(or `--since <date>`) to backfill history (W3). The README's "Pull your library"
section leads with that.

## 12. Implementation notes (2026-11-10)

What building P0 found that this plan did not say, or said differently. Spec
consequences are in `PRD-PIPELINE.md` v10.

| # | Finding | What the code does | Plan/PRD |
|---|---|---|---|
| I1 | **`npx @plaud-ai/mcp login` does not exist** in the pinned 0.3.14: sign-in is the package's `login` MCP tool, or its `install` command (which also rewrites Claude/Codex client configs). | `plaudport login` spawns the pinned package and calls its own `login` tool; Plaud's code runs the browser OAuth and writes `~/.plaud/tokens-mcp.json`. PlaudPort still never sees, stores or refreshes a token. | **P0-D2 amended — approved by the owner 2026-11-13.** PRD §4. |
| I2 | The package reads `PLAUD_API_BASE` (and other `PLAUD_*`) from its environment — the same names PlaudPort's `.env` uses for the v1 web API. Inherited, it would send the OAuth bearer to the wrong host. | The child gets a **minimal environment** (PATH, HOME, locale, proxy + CA vars) plus `PLAUD_TELEMETRY_DISABLED=1`; a test spawns it and checks no other `PLAUD_*` arrives. | PRD §4 |
| I3 | `--until D` as `D + 1` (§7 step 1) makes G2's one-day count include the next day. | An explicit `--until` is an exact inclusive bound; runs without it keep one day of slack past today (F6). | §7 superseded here |
| I4 | Rebuild must reproduce `recording_artifacts.last_checked_at` / `present_rev`, which the §6 manifest example (strings per artifact) cannot carry. | `states.artifacts.<a>` is `{state, lastCheckedAt, presentRev}`. `manifest.states` is the authority; `meta.json` holds a snapshot as of its revision. State-only changes (retry counters, last-seen, last-checked) are **manifest-only swaps** — a failed download does not mint a revision. | §6 example superseded |
| I5 | The startup sweep would re-verify every revision of every recording on every run. | Ledger column `manifest_hash` (derived; rebuild recomputes it): an unchanged manifest is skipped; a changed or unknown one is verified and its row re-derived. `last_seen_at` is refreshed at most hourly to avoid manifest churn. | §3 + 1 column |
| I6 | An explicitly empty highlights block (no button presses) is final; waiting 7 days for it kept nearly every bundle pending. | Resolves `absent` immediately; "not available yet" stays pending. | PRD FR1b |
| I7 | `first_seen − start_at` is inflated by backfills (`--all` first-sees year-old recordings), so "2 × max" of it is meaningless. | `report --lag` prints both; the implied window uses Plaud's `created_at − start_at`. | §7 table |
| I8 | G1c needs a hash re-check the plan named but no command provided. | `report --verify-audio N` (read-only; exit 1 on mismatch). | §9 G1c |
| I9 | Exit code for "needs sign-in" was unspecified. | `pull` exits **4** with the login instruction (0 ok · 1 error · 2 defects · 3 busy). | §7 |
| I10 | The presigned-audio host of the developer API is not known; the allowlist names the v1 buckets. | Downloads refuse non-allowlisted hosts (and non-HTTPS); the run logs the refused **hostname** once so the owner can add it deliberately. Recorded as a G-run item in `P0-GATE.md`. | — |
| I11 | Dependency versions. | `@modelcontextprotocol/sdk` **1.32.2** (≤ 1.31 carries published advisories); `better-sqlite3` **12.11.1** (13.x needs Node 22; the repo supports 20). Both exact-pinned. The pre-existing `zod` 3.x advisory is unchanged here. | P0-D7 |
| I12 | A recording's directory must not move if Plaud later edits `start_at`. | The dir is fixed at first sight; discovery finds it through the ledger, not by recomputing. | §6 |
| I13 | Some platforms reject `fsync` on a directory fd. | Treated as a best-effort no-op there (the strongest guarantee available); the spy test still checks every directory sync is issued. | §6 |

### Review response (implementation, `df9e081` → `fc957b8`)

Independent review (Codex) of the implementation PR at `df9e081`: request
changes, four findings, each reproduced on synthetic data. All fixed, each with
a regression test that fails on `df9e081`:

| # | Finding | Fix |
|---|---|---|
| CR-1 | **[P1]** The oldest pending bundles always filled the per-run text cap; later recordings could age out to `absent` without ever being checked. | Selection is never-checked first, then least-recently-checked; the cap counts fetches only; a bundle ages out only after at least one check (§4, §7 step 4 amended). |
| CR-2 | **[P1]** Writing after a revision fallback copied the fallback revision's files but kept the newer manifest's `present` states, so an artifact could be dropped and never re-fetched. | Artifacts the verifying revision lacks are reopened (`pending`, age-out clock restarted) — in `pull` and in the startup sweep / `index rebuild` — and fetched again. |
| CR-3 | **[P1]** A note entry with metadata but no string body (e.g. `data_content_error` when the package's linked-content fetch fails) counted as `present`. | A note is present only with a non-empty string body; anything else stays pending. |
| CR-4 | **[P2]** `data_link` (a signed URL) survived into `plaud/note.json`. | Transcript blocks and notes are passed through `stripSecrets` in the adapter and again before persistence; it also drops any signed-URL string value. |

Also added for the live gate: `plaudport gate g3b start|finish` (G3b).

Re-review of `51db58e`: the four reproductions pass; one new finding.

| # | Finding | Fix |
|---|---|---|
| CR-5 | **[P1]** A failed text fetch updated no timestamp, so a persistently failing recording stayed "never checked" and took the whole per-run cap every run. | The manifest records `states.textLastAttemptAt` on every attempt, success or failure (ledger column `text_last_attempt_at`, derived); scheduling rotates on it. Failures are still not *checks* (`lastCheckedAt` unchanged), so a failing recording never ages anything out — it is retried, fairly, indefinitely (FR1c spirit). |

The re-review also saw one intermittent failure of the cross-process lock test.

| # | Finding | Fix |
|---|---|---|
| CR-6 | **[P1, root-caused from the failure output]** A second acquirer got the lock while the holder reported `HELD`, with no busy error. Cause: the test holder dropped its `ArchiveLock` reference; the GC finalized the better-sqlite3 connection, closing the fd, and the OS released the lock while the process believed it held it. Reproduced deterministically with a forced GC. Production callers keep the reference until `release()`, so `pull`/`index rebuild` were not affected, but the guarantee must not depend on that. | `lock.ts` keeps a module-level strong reference to every held lock until `release()` or exit. Regression test (`hold-gc`: drop the reference, force GC, then contend) fails without the fix. The extended `SQLITE_BUSY_*` check added earlier stays as hardening; it did not explain this failure. |
