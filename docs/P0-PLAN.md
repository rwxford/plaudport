# P0 Plan — Pull

**Milestone:** P0 of `PRD-PIPELINE.md` · **Status:** Draft v3, revised after two
independent reviews (Codex, of `fa7bd06` and `d7229f5`) and a working-agent read;
**for re-review**, 2026-11-09 · **Implements:** FR1, FR1a–d, FR2 (interface +
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
| P0-D2 | Login is the owner's job, once: `plaudport doctor` detects a missing/expired `~/.plaud/tokens-mcp.json` and tells the owner to run `npx @plaud-ai/mcp login` (browser). PlaudPort never drives the OAuth flow itself. | Keeps PlaudPort out of the credential-acquisition business; the refresh token then carries unattended runs. |
| P0-D3 | Ledger = SQLite (`better-sqlite3`), one file under the archive root (`<archive-root>/.plaudport/ledger.sqlite`), **derived and rebuildable** from manifests (FR14c). | PRD §7. Co-locating with the archive means a moved archive brings its ledger. |
| P0-D4 | The new archive (FR14) is a **new tree**, `<archive-root>/<YYYY>/<MM>/<id>/`, separate from the v1 `data/shares/` and `data/imports/` trees. v1 trees are left untouched in P0; a one-way `plaudport migrate-v1` is a P3 question, recorded in §9. | Avoids two live formats in one tree while keeping v1 commands working. |
| P0-D5 | P0 writes revision `rev-0001/` containing only `plaud/` text artifacts and the recording's `meta.json`; `audio.mp3` is written once at the recording root. The revision/manifest machinery (FR14b) is built in full in P0 even though P0 produces one revision, because P1+ will add revisions and the atomicity contract must be tested now. | Build the invariant before anyone depends on it. |
| P0-D6 | No web UI changes in P0. CLI only. | Scope. |
| P0-D7 | New dependencies: `better-sqlite3` (ledger), `@modelcontextprotocol/sdk` (MCP client). `@plaud-ai/mcp` is **not** a runtime dependency; it is pin-installed and exec'd (P0-D1) so Plaud's updates do not silently change behaviour. | Minimal footprint, pinned. **`better-sqlite3` is the repo's first native dependency** (W2): under the Homebrew formula now on `main`, `npm ci` builds or fetches a prebuilt binary matching Homebrew's pinned Node ABI, the same per-arch install class as `tsx`/`esbuild`; `doctor` verifies the native build (T10, R6). |
| P0-D8 | **One archive-level exclusive writer lease, with fencing** (`<archive-root>/.plaudport/lock`) guards every mutating operation — `pull`, `reconcile`, `index rebuild`, and the cleanup pass. The lock file records `{pid, host, bootId, startedAt, renewedAt, epoch}`. The holder **renews `renewedAt` every `PLAUDPORT_LOCK_HEARTBEAT_SECONDS`** (default 60) for as long as it works. A contender may take over **only** when (a) the lock's `host`+`bootId` match this machine and its `pid` is dead (definitive proof the owner is gone), **or** (b) the lease has expired — `now − renewedAt > PLAUDPORT_LOCK_LEASE_SECONDS` (default 180, ≥ 3× heartbeat). **Age of `startedAt` never triggers takeover** (R2-1): a legitimate multi-hour backfill keeps renewing and is never stolen. Takeover writes a **new `epoch`** and WARNs. **Fencing:** the holder re-reads the lock and checks `epoch` is still its own immediately before each revision/manifest/cleanup write; if it has changed, the run **aborts with "lock lost"** rather than writing — so a suspended process that wakes after its lease was reclaimed cannot corrupt the archive. Revision-number allocation reads existing `rev-*` dirs under the held lease. A second `pull` facing a live lease exits 3 ("archive busy"); it does not wait. | C3, R2-1. Single-writer is sufficient for a single-user tool; a renewed lease with fencing is the honest way to tell "crashed/suspended" from "slow but alive" without stomping a live writer. |
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

**Concurrency (C3, R2-1).** Every mutating operation runs **under the archive
writer lease with fencing** (P0-D8). Because there is only ever one live writer,
revision numbers cannot collide and cleanup cannot race another writer's
uncommitted revision; the fence (`epoch`) means a writer whose lease was
reclaimed while it was suspended **aborts instead of writing**. The lease is
acquired before step 0, renewed throughout, and released after step 4;
`index rebuild` and the cleanup pass take it too. Each numbered step below
re-checks the fence before its first durable write.

Write protocol (FR14b), implemented once in `src/archive/revision.ts` and used
by every writer from P0 on. **`fsync` ordering is the crash-safety contract**;
step 0 is the manifest-first discovery write (C1):

0. **Discovery write** (first sight of an id, before any download). **Idempotent
   and manifest-authoritative (R2-3):** if the recording directory and a valid
   `manifest.json` already exist, do **not** re-initialize — adopt it and
   reconcile the ledger row from the manifest. Otherwise create the
   `<YYYY>/<MM>/<id>` tree and, because those parents may be new, **`fsync` each
   newly-created directory up through the nearest pre-existing archive ancestor**
   (R2-4), so the path itself is durable, not just the files inside it. Then
   write `rev-0001/meta.json`; `fsync` the file; `fsync` `rev-0001/`; `fsync` the
   recording directory; write the initial `manifest.json` (step 3). From here the
   id is durable.
1. Allocate `rev-NNNN` by reading existing `rev-*` under the lease. Create
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
silently repaired.

`PLAUDPORT_ARCHIVE_ROOT` default: `./data/archive` (development). `doctor`
warns when the root is on the boot volume and no backup location
(`PLAUDPORT_BACKUP_HINT`, free text the owner sets to acknowledge they have
one) is configured (FR14a).

## 7. Discovery algorithm (FR1, FR1a, FR1d)

```
pull [--since D] [--until D] [--all] [--reconcile] [--recheck-text …] [--dry-run]
  0. acquire the archive writer lease (P0-D8); exit 3 "archive busy" if a live
     lease is held; adopt/reconcile any stale lease per P0-D8.
  0b. STARTUP RECONCILE (R2-3): scan recording dirs whose manifest is newer than,
     or absent from, the ledger (cheap: compare manifest mtime/epoch to the row);
     re-derive those ledger rows from the manifest. The manifest is authority.
  1. window.to   = --until ? (D + 1 day) : today(UTC) + 1 day
     window.from = --all ? EPOCH : --since ?? (max(start_at in ledger) − OVERLAP_DAYS − 1 day)
                    (first run with empty ledger: today − OVERLAP_DAYS; owner uses --since/--all to backfill)
  2. for page = 1..: list(window, {page, pageSize: 100}); stop when < 100 returned
     for each item with NO durable record (no recording dir AND not in ledger):
         DISCOVERY WRITE (§6 step 0) — write rev-0001/meta.json + manifest
         (audio null/pending, all artifacts pending) BEFORE any download, then
         UPSERT the derived ledger row and record sync_lag_samples (lag =
         first_seen_at − start_at, and created_at − start_at).
     for each item whose recording dir/manifest EXISTS but ledger row is missing
         or stale: ADOPT it (reconcile the row from the manifest), never
         re-initialize — this is the crash-after-manifest-before-UPSERT case.
         A fully-known item just updates last_seen_at.
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
| T1 | Add `PLAUDPORT_ARCHIVE_ROOT`, `PLAUDPORT_PULL_OVERLAP_DAYS`, `PLAUDPORT_PLAUD_TEXT_TIMEOUT_DAYS`, `PLAUDPORT_RETRY_REPORT_AFTER`, `PLAUDPORT_TEXT_CHECKS_PER_RUN`, `PLAUDPORT_REVISION_HISTORY`, `PLAUDPORT_LOCK_HEARTBEAT_SECONDS`, `PLAUDPORT_LOCK_LEASE_SECONDS`, `PLAUDPORT_BACKUP_HINT`, `PLAUD_MCP_PACKAGE_VERSION` to `.env.example`, `config.ts` (zod), README/ADVANCED tables; **add the default archive root (`data/archive/`) to `.gitignore`** (W3) | FR14a, §13 | `config.test.ts`: defaults, bounds, rejects nonsense (incl. lease ≥ 3× heartbeat); a test asserts the archive glob is gitignored | a |
| T2 | `src/archive/revision.ts`: write/read protocol of §6 — idempotent discovery write (step 0), full `fsync` ordering, trim, cleanup, fallback, corrupt detection — **all under the writer lease (T2a)** | FR14b, C1, C4, R2-4 | `revision.test.ts`: crash injection between every step (temp dir left, manifest not swapped, artifact missing, hash mismatch) → reader behaviour exactly as §6; a spy asserts the `fsync` ordering (each file, nested dir, rev dir, **recording dir after each rename**, **each newly-created `<YYYY>/<MM>/<id>` parent up to a pre-existing ancestor**, audio before manifest) is issued; property test: N random write/crash sequences never lose a verified revision | a |
| T2a | `src/archive/lock.ts`: archive-level exclusive **writer lease with fencing** (P0-D8) — `{pid,host,bootId,startedAt,renewedAt,epoch}`, heartbeat renewal, takeover only on dead-pid-same-host or expired lease, epoch bump + fence check | FR14b, C3, R2-1 | `lock.test.ts`: two interleaved writers serialize (no duplicate `rev-NNNN`, no cleanup of an uncommitted revision); **a live process holding an old (`startedAt` > lease) but actively-renewed lease is NOT stolen**; an expired-lease / dead-pid lock IS taken over; **a fenced-out writer (epoch changed under it) aborts instead of writing** | a |
| T3 | `src/ledger/db.ts` + schema (incl. `recording_artifacts`) + `index rebuild` from manifests | FR14c, C1, C2 | `ledger.test.ts`: build from fixture archive, drop db, rebuild, **dump of the derived tables** (`recordings`, `recording_artifacts`, `sync_lag_samples`) is identical; `runs`/`defects` are not reproduced by design; **rebuild after discovery-only** (no audio yet) keeps the id; **rebuild after a failed download** keeps the `audio_failed` row; corrupt recording excluded and reported | a |
| T4 | `src/pull/states.ts` pure state machines + backoff | FR1b, FR1c, C2 | `states.test.ts`: audio transition table incl. expired-URL path is not an attempt, age-out boundary, backoff cap and jitter bounds; **per-artifact text machines**; bundle state derived from the five artifacts (ok only when all present-or-absent; absent only when all absent) | a |
| T5 | `src/sources/types.ts`, `src/sources/plaudMcp.ts` with zod response schemas | FR2, F8 | `plaudMcp.test.ts` against **fake MCP server** (T6): list paging, detail, text with cursor pages, auth error mapping, telemetry env set on spawn | a |
| T6 | `scripts/fake-plaud-mcp.mjs`: a stdio MCP server serving fixture recordings (synthetic audio, synthetic transcripts) with knobs: late-appearing recording, **each Plaud artifact appearing independently after its own N calls** (transcript before note, note before transcript, highlights empty), presigned URL that expires after T seconds, 429 on demand, > 500 recordings mode | FR1a–d, C2 test bed | used by T5, T7, T8; `demo.mjs` step 6 | a |
| T7 | `src/pull/pull.ts` + CLI `plaudport pull` per §7 (`--since`, `--until`, `--all`, `--dry-run`, `--recheck-text`) incl. startup reconcile (§7 step 0b) | FR1, FR1a–c, FR3, C1, C2, C6, R2-2, R2-3 | `pull.test.ts` on fake server: late recording discovered by overlap; failed download retried next run; expired URL re-fetched without an attempt; **a crash between the manifest commit and the ledger UPSERT, then an ORDINARY pull (not rebuild), adopts the id — no re-initialize, no duplicate, no overwrite of a later revision** (R2-3); **a bundle first revisited AFTER its age-out deadline resolves to `absent` without stalling pending** (R2-2); **staggered artifacts are all eventually collected** (transcript then note each add a revision); `mark_memo` stored; `--dry-run` writes nothing; `--until` bounds the window to one day | a |
| T8 | `--reconcile` + `defects` + exit code 2 | FR1d | `pull.test.ts`: seed a recording directly into the fake server with a `start_at` older than the window → defect logged, then archived | a |
| T9 | `plaudport report [--lag]` and run JSON; redaction applied | FR22, §13 | `report.test.ts`: report contains no names/ids with redaction on; lag stats correct on fixtures | a |
| T10 | `plaudport doctor` (P0 subset): Node version, archive root + backup hint, `@plaud-ai/mcp` **installed at the pinned version** (reports installed-vs-pinned drift and offers re-install, W1), token file present and not expired (reads `expiresAt` only), `better-sqlite3` native build OK (W2), and a stale writer-lock report | FR21 | `doctor.test.ts` with injected environment, incl. a drifted version and a stale lock | a |
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
| G1 | Full-library paging: `pull --all --dry-run` lists every recording; total equals the count shown in Plaud web (owner reads it off the UI) | b | owner logged in via `npx @plaud-ai/mcp login`; library > 500 (F4) | owner | listed count, web count, pages fetched, 429 count |
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
- **R7. Writer-lease recovery (C3, R2-1).** A process killed mid-pull leaves the
  lock file; the next run takes over only when the pid is dead on this host **or**
  the lease (`renewedAt`) has expired — never on `startedAt` age — and logs that
  it did so. A genuinely running pull keeps renewing and is never stomped,
  however long its backfill takes; a crashed or suspended one stops renewing and
  is reclaimed, and the fence (`epoch`) stops it writing if it later wakes. The
  one residual case — a wall-clock jump large enough to expire a live lease
  between heartbeats — is bounded by the ≥ 3× heartbeat margin and closed by the
  fence, which fails the stale writer's next write rather than corrupting.
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
npx @plaud-ai/mcp@<pinned> login         # once; browser; tokens in ~/.plaud/
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
