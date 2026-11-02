# P0 Plan — Pull

**Milestone:** P0 of `PRD-PIPELINE.md` v6 · **Status:** Draft v1 for independent
review, 2026-11-01 · **Implements:** FR1, FR1a–d, FR2 (interface + `plaud-mcp`
adapter), FR3, FR14, FR14a–c, FR21 (partial), FR22 (partial) · **Does not
touch:** anything in P1+ (no transcription, diarization, biometric store,
summaries, publishers, MCP server).

This plan was written in a planning-only session. No code was changed. Per
`CLAUDE.md`, implementation starts in a fresh session after this plan is
reviewed and approved.

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
| P0-D1 | `plaud-mcp` adapter = spawn `npx -y @plaud-ai/mcp@<pinned>` as a stdio MCP server; talk to it with `@modelcontextprotocol/sdk` `Client`. | F1, F10. Official, refresh-capable, no reverse engineering. Pin the version; `doctor` reports drift. |
| P0-D2 | Login is the owner's job, once: `plaudport doctor` detects a missing/expired `~/.plaud/tokens-mcp.json` and tells the owner to run `npx @plaud-ai/mcp login` (browser). PlaudPort never drives the OAuth flow itself. | Keeps PlaudPort out of the credential-acquisition business; the refresh token then carries unattended runs. |
| P0-D3 | Ledger = SQLite (`better-sqlite3`), one file under the archive root (`<archive-root>/.plaudport/ledger.sqlite`), **derived and rebuildable** from manifests (FR14c). | PRD §7. Co-locating with the archive means a moved archive brings its ledger. |
| P0-D4 | The new archive (FR14) is a **new tree**, `<archive-root>/<YYYY>/<MM>/<id>/`, separate from the v1 `data/shares/` and `data/imports/` trees. v1 trees are left untouched in P0; a one-way `plaudport migrate-v1` is a P3 question, recorded in §9. | Avoids two live formats in one tree while keeping v1 commands working. |
| P0-D5 | P0 writes revision `rev-0001/` containing only `plaud/` text artifacts and the recording's `meta.json`; `audio.mp3` is written once at the recording root. The revision/manifest machinery (FR14b) is built in full in P0 even though P0 produces one revision, because P1+ will add revisions and the atomicity contract must be tested now. | Build the invariant before anyone depends on it. |
| P0-D6 | No web UI changes in P0. CLI only. | Scope. |
| P0-D7 | New dependencies: `better-sqlite3` (ledger), `@modelcontextprotocol/sdk` (MCP client). `@plaud-ai/mcp` is **not** a dependency; it is executed via `npx` at a pinned version so Plaud's updates do not silently change behaviour. | Minimal footprint, pinned. |

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
  text_state    TEXT NOT NULL CHECK (text_state IN
                  ('plaud_text_pending','plaud_text_ok','plaud_text_absent')),
  text_last_checked_at TEXT,
  text_pending_since TEXT,
  manifest_rev  TEXT                       -- current revision id from manifest.json
);
CREATE INDEX recordings_start_at ON recordings(start_at);
CREATE INDEX recordings_states   ON recordings(audio_state, text_state);

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
`list_files` item and `get_file` metadata (minus `presigned_url`), so a rebuild
needs nothing outside the archive.

## 4. State machines (FR1b, FR1c)

**Audio** (per recording):

```
discovered ──▶ audio_pending ──download ok, sha256 recorded──▶ audio_ok
                   │  ▲
                   │  └── retry when now ≥ audio_next_retry_at
                   └──download error──▶ audio_failed (attempts++, next_retry_at = backoff)
```

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

**Plaud text** (per recording):

```
plaud_text_pending ──get_transcript/get_note return content──▶ plaud_text_ok
        │
        └── now − text_pending_since > PLAUDPORT_PLAUD_TEXT_TIMEOUT_DAYS ──▶ plaud_text_absent
```

- Checked on every `pull` for every pending id, oldest first, capped per run
  (`PLAUDPORT_TEXT_CHECKS_PER_RUN`, default 200) so a large backlog cannot
  starve discovery.
- `plaud_text_absent` is terminal for automation but `pull --recheck-text <id>`
  or `--recheck-text --all` can reopen it (Plaud transcribes late when minutes
  refresh at month boundary — expected once the plan drops to Starter).
- "Content" means: at least one `transaction` utterance **or** a non-empty
  note. `mark_memo` is fetched whenever the transcript is (FR3) and stored even
  if empty.

Both machines are pure functions over `(state, event, now, config)` in
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
  "states": { "audio": "audio_ok", "text": "plaud_text_ok", "textPendingSince": null }
}
```

Write protocol (FR14b), implemented once in `src/archive/revision.ts` and used
by every writer from P0 on:

1. Create `rev-NNNN.tmp/`, write every artifact via temp-name + rename inside
   it, `fsync` each file, then `fsync` the directory and rename to `rev-NNNN/`.
2. Build the new manifest in memory: `current` ← new rev with hashes, previous
   `current` prepended to `history`, `history` trimmed to
   `PLAUDPORT_REVISION_HISTORY` (default 3).
3. Write `manifest.json.tmp`, `fsync`, rename over `manifest.json`.
4. Delete revision directories that are in neither `current` nor `history`,
   and any `*.tmp` directories older than one hour.

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
pull [--since D] [--all] [--reconcile] [--recheck-text …] [--dry-run]
  1. window.to   = today(UTC) + 1 day
     window.from = --all ? EPOCH : --since ?? (max(start_at in ledger) − OVERLAP_DAYS − 1 day)
                    (first run with empty ledger: today − OVERLAP_DAYS; owner uses --since/--all to backfill)
  2. for page = 1..: list(window, {page, pageSize: 100}); stop when < 100 returned
     for each item: UPSERT recordings (states default pending); record sync_lag_samples
                    on first sight (lag = first_seen_at − start_at, and created_at − start_at)
  3. select audio_pending ∪ (audio_failed where next_retry_at ≤ now), oldest start_at first:
       detail(id) → download → verify → write audio.mp3 → manifest (audio) → state
  4. select plaud_text_pending (cap TEXT_CHECKS_PER_RUN), oldest first:
       text(id) → if content: write rev-NNNN with plaud/* → plaud_text_ok
                 else if aged out → plaud_text_absent else touch last_checked_at
  5. write run row + report JSON (redacted: counts, states, error classes; no names/ids
     unless PLAUD_REDACT_SAMPLES=false)
--reconcile: window = EPOCH..today+1; list everything; every id not in ledger →
  defects row + WARN "discovery defect"; then proceed as a normal pull so the item is
  also archived. Exit code 2 when defects > 0 so the scheduler can surface it.
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
| T1 | Add `PLAUDPORT_ARCHIVE_ROOT`, `PLAUDPORT_PULL_OVERLAP_DAYS`, `PLAUDPORT_PLAUD_TEXT_TIMEOUT_DAYS`, `PLAUDPORT_RETRY_REPORT_AFTER`, `PLAUDPORT_TEXT_CHECKS_PER_RUN`, `PLAUDPORT_REVISION_HISTORY`, `PLAUDPORT_BACKUP_HINT`, `PLAUD_MCP_PACKAGE_VERSION` to `.env.example`, `config.ts` (zod), README/ADVANCED tables | FR14a, §13 | `config.test.ts`: defaults, bounds, rejects nonsense | a |
| T2 | `src/archive/revision.ts`: write/read protocol of §6, including trim, cleanup, fallback, corrupt detection | FR14b | `revision.test.ts`: crash injection between every step (temp dir left, manifest not swapped, artifact missing, hash mismatch) → reader behaviour exactly as §6; property test: N random write/crash sequences never lose a verified revision | a |
| T3 | `src/ledger/db.ts` + schema + `index rebuild` from manifests | FR14c | `ledger.test.ts`: build from fixture archive, drop db, rebuild, byte-identical dump; corrupt recording excluded and reported | a |
| T4 | `src/pull/states.ts` pure state machines + backoff | FR1b, FR1c | `states.test.ts`: full transition table, expired-URL path is not an attempt, age-out boundary, backoff cap and jitter bounds | a |
| T5 | `src/sources/types.ts`, `src/sources/plaudMcp.ts` with zod response schemas | FR2, F8 | `plaudMcp.test.ts` against **fake MCP server** (T6): list paging, detail, text with cursor pages, auth error mapping, telemetry env set on spawn | a |
| T6 | `scripts/fake-plaud-mcp.mjs`: a stdio MCP server serving fixture recordings (synthetic audio, synthetic transcripts) with knobs: late-appearing recording, transcript that appears after N calls, presigned URL that expires after T seconds, 429 on demand, > 500 recordings mode | FR1a–d test bed | used by T5, T7, T8; `demo.mjs` step 6 | a |
| T7 | `src/pull/pull.ts` + CLI `plaudport pull` per §7 (`--since`, `--all`, `--dry-run`, `--recheck-text`) | FR1, FR1a–c, FR3 | `pull.test.ts` on fake server: late recording discovered by overlap; failed download retried next run; expired URL re-fetched without an attempt; text pending → ok; text age-out; `mark_memo` stored; `--dry-run` writes nothing | a |
| T8 | `--reconcile` + `defects` + exit code 2 | FR1d | `pull.test.ts`: seed a recording directly into the fake server with a `start_at` older than the window → defect logged, then archived | a |
| T9 | `plaudport report [--lag]` and run JSON; redaction applied | FR22, §13 | `report.test.ts`: report contains no names/ids with redaction on; lag stats correct on fixtures | a |
| T10 | `plaudport doctor` (P0 subset): Node version, archive root + backup hint, `@plaud-ai/mcp` reachable at pinned version, token file present and not expired (reads `expiresAt` only), `better-sqlite3` native build OK | FR21 | `doctor.test.ts` with injected environment | a |
| T11 | Extend `scripts/demo.mjs`: step 6 runs T6 + `pull` twice (second run exercises retry + late sync), then `index rebuild`, asserts ledger equality | FR1, FR14c | `npm run demo` PASS | a |
| T12 | Docs: `docs/CLI.md`, `docs/ADVANCED.md` Scripts/Roadmap, README "Pull your library" section, `docs/BACKUP.md` stub noting FR14d is P5 | — | review | — |
| T13 | **Live gate run** (owner): §9 checklist, results recorded in `docs/P0-GATE.md` with counts only | FR1, §9 | — | **b** |
| T14 | PRD edits in the same PR: F2 resolves O1 (record the observed behaviour and that the docs page is wrong); §4 gains the `@plaud-ai/mcp` facts; changelog v7 | CLAUDE.md living-spec rule | review | — |

## 9. P0 exit gate — checklist

From PRD §9. Each line states its class, prerequisite, who runs it, and how
the result is recorded. Anything not run is recorded as **pending** in
`docs/P0-GATE.md`, never implied.

| # | Check | Class | Prerequisite | Runs | Evidence recorded |
|---|---|---|---|---|---|
| G1 | Full-library paging: `pull --all --dry-run` lists every recording; total equals the count shown in Plaud web (owner reads it off the UI) | b | owner logged in via `npx @plaud-ai/mcp login`; library > 500 (F4) | owner | listed count, web count, pages fetched, 429 count |
| G1a | Same as G1 via the local package confirms F2 (filtered paging works) | b | as G1 | owner | page count and distinctness check from `report` |
| G2 | Dense day: `pull --since <day> --dry-run` on a day with ≥ 10 recordings matches the web UI for that day | b | owner picks the day | owner | count vs. web count |
| G3 | Expired URL: `pull` on one recording with `PLAUDPORT_DEBUG_URL_AGE_HOURS=25` (debug override forcing the freshness rule) completes the download via re-fetch; attempts stays 0 | b (+ a on fake) | one pending recording | owner | ledger row: state, attempts |
| G4 | Transcript-less recording lands `plaud_text_pending` and later resolves | b | a recording Plaud has not yet transcribed (common within minutes of sync) | owner, two runs ≥ 10 min apart | state before/after |
| G5 | Late-synced recording discovered: owner records on the Note Pro with the phone app closed, syncs the next day, runs `pull`; recording appears with `created_at − start_at > 12 h` and inside the overlap window | b | Note Pro, one day | owner | lag hours from `report --lag` |
| G6 | `pull --reconcile` reports 0 defects after G1 | b | G1 done | owner | defects count |
| G7 | `index rebuild` after G1 reproduces an identical ledger (SQL dump diff) | a + b | G1 done | owner | diff is empty |
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
- **Q1 (for P3).** Migrate v1 `data/shares/` and `data/imports/` into the new
  tree? Those recordings have no Plaud id of their own (share imports do have
  the uploaded `of_` id); defer.
- **Q2 (for P1).** The transcript pager returns utterances with speaker labels
  from Plaud; P1's normalized transcript must keep Plaud's labels as
  `plaud/` provenance only, never as identity (FR8a).

## 11. What the owner should expect to run

```bash
npm install                              # adds better-sqlite3, @modelcontextprotocol/sdk
npx @plaud-ai/mcp@<pinned> login         # once; browser; tokens in ~/.plaud/
npm run doctor                           # all green before pulling
npm run pull -- --since 2026-10-01 --dry-run   # G2-style check, writes nothing
npm run pull -- --all                    # first full archive; long
npm run pull -- --reconcile              # G6
npm run report -- --lag                  # §13 calibration readout
```
