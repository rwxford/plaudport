# PRD — Plaud as Capture Device, Everything Else Local ("PlaudPort v2")

**Status:** Draft v9, approved to start P0 (plan in re-review) · **Owner:** Ross Weatherford (rwxford) ·
**Priority:** primary. Supersedes `PRD-SHARE-IMPORT.md` as the main line of work;
share import and the upload path (`UPLOAD-API.md`) become sub-features of this one.

> **This document is the source of truth and it is allowed to change.** When
> implementation finds that reality disagrees with a requirement, the fix is an
> edit here (with a changelog entry) in the same PR as the code, not a
> workaround in code that leaves the spec wrong. Numbers in §13 are defaults
> to be validated, not decisions.

### Changelog

| Version | Date | Change | Driver |
|---|---|---|---|
| v1 | 2026-10-29 | Initial draft | Plaud 4.0 credits/regressions; owner decisions D1–D8 |
| v2 | 2026-10-29 | FR1a–d id-based discovery with readiness states; FR8c–d versioned assignments + invalidation; FR14a–e backup/restore; ground-truth P1/P2 gates; P0 library-access gate | Independent review #1 (Codex) |
| v3 | 2026-10-29 | FR8c-i/ii re-score all auto assignments, manual corrections persist; FR8e retraction of published errors; FR14b immutable revisions + atomic pointer; P2 gate cites measurable criteria | Independent review #2 (Codex) |
| v4 | 2026-10-30 | FR10/10a–d all embeddings in the protected biometric store, unenrolled-embedding retention; FR14b manifest `current` + `history`; numeric DER bar | Independent review #3 (Codex) |
| v5 | 2026-11-01 | Living-spec rule; §13 "Defaults to validate"; non-negotiables moved to `CLAUDE.md`; status → approved to start P0 | Process review before kickoff |
| v6 | 2026-11-01 | §13 evidence classes (automated / live-account / calibration; pending state); `CLAUDE.md` extends independent review to implementation PRs with recorded SHA + disposition, and corrects the summaries-are-local wording | Independent review #4 (Codex), of `8c60cfc` |
| v7 | 2026-11-09 | FR1b → **per-artifact** Plaud-text readiness (a transcript arriving before its note no longer freezes the bundle); FR14b gains the **single-writer archive lock** and the **power-loss `fsync` ordering** (nested dirs + recording dir after renames); FR14c **scopes** "derived/rebuildable" to the recording state (`recordings`, per-artifact readiness, lag samples) and names `runs`/`defects` as observational, not reproduced | P0-PLAN v1 review — Codex request-changes (C1–C6) + working-agent read (W1–W3); see `P0-PLAN.md` §0 |
| v8 | 2026-11-09 | FR14b writer lock → **renewed lease with fencing** (no takeover on age alone; an epoch fence aborts a reclaimed writer's writes) and adds **newly-created parent-dir `fsync`** to the ordering; FR14c adds **manifest-as-authority + idempotent discovery** (crash between manifest commit and ledger update is recovered by an ordinary `pull`) | P0-PLAN v2 review — Codex request-changes (R2-1…R2-4 + G7/T11 cleanup); see `P0-PLAN.md` §0 |
| v9 | 2026-11-09 | FR14b lock → **OS-held exclusive lock** (held across suspension, released on exit) replacing the user-space lease+fence, which had a check-then-write TOCTOU; and names a dir with **no committed manifest** an *interrupted initialization* (recovered under the lock), distinct from a corrupt committed manifest | P0-PLAN v3 review — Codex request-changes (R3-1 fencing TOCTOU, R3-2 interrupted init); see `P0-PLAN.md` §0 |

**Review process.** Each revision is reviewed by a model other than the one
drafting it (Codex), working from the committed document rather than the
drafting conversation; findings are numbered and addressed in the next
version, and the changelog records the reviewed commit from v6 onward. From
P0 onward, plans and implementation PRs get the same treatment, as fresh-
context Codex Code Review runs (see `CLAUDE.md` §"How we work" 3). The
document is "good enough" when remaining findings would be settled faster by
building the next milestone than by rewriting prose; v4 reached that point for
P0, and v5–v6 are process, not design, changes.

## 1. Problem

Plaud is four layers: (1) hardware capture, (2) sync and cloud storage,
(3) transcription, diarization and speaker identity, (4) the AI layer (summaries,
Ask Plaud, agent). In October 2026 Plaud added a credits meter to layer 4 (Ask
Plaud "Work" mode, Artifacts, Routines, Connectors burn credits; top-up prices
unpublished), while layer 3 regressed: users report the loss of voice profiles
and no visible work on transcription accuracy. The hardware (layer 1) remains the
best part of the product.

What users are reporting (r/PlaudNoteUsers, "Enshittification of Plaud with 4.0",
2026-10-29; the original was removed from r/PLAUDAI):

- Speaker auto-tagging removed mid-subscription, without compensation; users on
  Unlimited now hand-label every speaker.
- AutoFlow, previously free, converted into a credit-metered paid feature.
- A sudden spike in speech-to-text error rates after the engine change.
- USB mass-storage access removed by policy "for security", so the device can
  no longer be managed as a drive even where the hardware allowed it.
- A new Terms of Service: Plaud buys employer, title, seniority and location
  from data brokers for marketing; infers the user's organization from the email
  domain and may share aggregate usage with that organization and with
  prospective business customers; shares hashed emails with ad platforms; and
  keeps **voiceprints** as the one category with its own retention rule.
- Observed here on 2026-10-27: Plaud attributed a participant to the wrong real
  person and invented a title for another from a name collision. A confidently
  wrong name is worse than `Speaker 2`, because it poisons downstream notes.

Today PlaudPort's job is to push audio **into** Plaud so the Plaud MCP can see
it. That makes Plaud the system of record for every meeting, which is exactly
the dependency to get out of.

## 2. Goal

Invert the flow. **Plaud is the source; a local archive on the owner's Mac is the
system of record.** PlaudPort pulls every recording, transcribes and diarizes it
locally with a better engine than Plaud's, re-creates voice profiles as a local,
private speaker library, summarizes with Claude using the owner's own templates,
publishes to the places the owner reads, and exposes the whole archive to Claude
through a local MCP server.

End state: the Plaud subscription can drop to the free Starter plan with no loss
of capability, because the only thing still bought from Plaud is capture plus
cloud sync, which Starter includes.

### Decisions (2026-10-29)

| # | Decision | Reasoning |
|---|---|---|
| D1 | **Device: Plaud Note Pro.** Transfer is Bluetooth/Wi-Fi to the phone app only, proprietary charging port, no USB file access. | Plaud's own support articles. The USB-mount route exists only on the original Note and is out of scope. |
| D2 | **Source of audio: Plaud cloud, via the official Plaud MCP first, the reverse-engineered client second.** | `get_file` returns a presigned 24-hour audio URL for any recording. It is sanctioned, read-only, and works on Starter. The unofficial client is the fallback when the MCP lacks something (e.g. bulk listing beyond 500). |
| D3 | **Transcription: local by default, cloud as an explicit opt-in fallback.** | Recordings contain sensitive customer conversations and internal pipeline/pricing content. Local processing on a 24 GB M4 is free at ~50 h/month and keeps that audio off a third STT vendor. |
| D4 | **Speaker identity: rebuild voice profiles locally** from speaker embeddings, never in any cloud. | The feature Plaud dropped. Embeddings are biometric data; local-only is the only acceptable home for them. |
| D5 | **Summaries: Claude**, via the Agent SDK or `claude` CLI, with templates in the repo. | Already the owner's reasoning layer; MEDDPIC and account-note templates are his, not Plaud's. |
| D6 | **Destinations: local store (canonical) → optional Notion → optional markdown vault in a private GitHub repo. Everything reachable by Claude through a local MCP server.** | Local store is always correct; publishers are projections of it and can be re-run. |
| D7 | **Run Plaud Unlimited and the pipeline in parallel for one full cycle before downgrading.** | Plaud's speaker labels and summaries stay as the control group until local output is demonstrably at least as good. |
| D8 | **Node stays the host; Python runs as a managed sidecar** for the ML engines. | The repo, CLI, web UI, credential sync and ledger are Node. The transcription/diarization ecosystem is Python/MLX. One `plaudport doctor` sets up the sidecar venv. |

## 3. Scope

**In:** incremental pull of new recordings (audio + whatever transcript/summary
Plaud produced, while the plan still produces one) · local transcription with
pluggable engines · diarization · speaker identification against an enrolled
local voice library · Claude summaries from templates · publish to local store,
Notion, markdown vault · local MCP server · scheduled unattended runs ·
reconciliation report.

**Out (v2):** editing or deleting anything in Plaud · a hosted service · multi-user
· replacing the Plaud phone app for device sync (the app remains the only way
audio leaves a Note Pro) · live/streaming transcription · Gong fetch (`GONG.md`
Phase 2, still blocked on a credential).

**Kept from v1 as sub-features:** share-link import (`import`), file import,
`push` back to Plaud (renamed from the current default path; optional).

## 4. Domain constraints (verified 2026-10-29)

- **Starter plan keeps syncing.** Plaud: when minutes run out, "your device keeps
  recording… Private Cloud Sync keeps working. Transcription simply pauses."
  Manual: 10,000 minutes of free cloud storage. Downgrade removes transcription
  and in-app summaries, not capture or sync.
- **Volume.** 2026-10-28/29 show ~10 recordings/day, several 30–70 min; plan for
  40–60 h/month, bursts of 3–4 h/day.
- **Plaud MCP** exposes `list_files` (date filters server-side; name search scans
  newest 500), `get_file` (metadata + presigned audio URL, 24 h), `get_transcript`
  (`transaction`, `transaction_polish`, `outline`, `mark_memo` highlights),
  `get_note`. `serial_number` is null on observed records.
- **Web-API bearer expires in ~1 day**; the Chrome extension refreshes it only
  while Chrome visits Plaud. Unchanged from `UPLOAD-API.md`.
- **No transcript write-back to Plaud.** Still no endpoint. v2 no longer needs one.
- **Note Pro native file format is unknown** and irrelevant under D1/D2: audio
  arrives as the MP3 Plaud serves.

## 5. Functional requirements

### Pull
- FR1. `plaudport pull [--since <date>] [--all]` discovers recordings in Plaud,
  downloads audio to the archive, and stores Plaud's transcript/summary/
  highlights alongside when they exist. Idempotent; resumable; sha256 recorded;
  never mutates Plaud. **Discovery is by recording id, not by a high-water
  mark.** A cursor alone would permanently miss a recording that syncs late
  from the device (common: the phone app uploads hours after the meeting) or
  one whose download failed while later ones succeeded.
- FR1a. **Overlapping discovery.** Each run lists a window that reaches back a
  configurable period (default 14 days) before the newest known recording, plus
  any ids still in a non-final state. Every id seen is upserted into the ledger
  before any download starts, so a crash cannot lose knowledge of a recording.
- FR1b. **Readiness states, tracked separately** for audio and for Plaud's
  derived data: `discovered → audio_pending → audio_ok | audio_failed` for audio,
  and **per-artifact** for Plaud text. Plaud produces up to five derived
  artifacts — transcript, polished transcript, outline, highlights (`mark_memo`),
  and the AI note — **asynchronously and independently**, so one can exist long
  before another. Each is tracked `pending → present | absent` on its own; the
  recording's text bundle is `pending` while any artifact is still pending and
  the bundle has not aged out, `ok` once all are present-or-absent, `absent` only
  if all aged out. `pull` re-checks **each still-pending artifact** on every run
  until it resolves or the bundle ages out (configurable; default 7 days →
  `absent`). Marking the bundle complete on the first artifact to arrive would
  silently drop the rest, so readiness is never a single per-recording flag.
- FR1c. **Persistent retries by id.** `audio_failed` and expired-URL cases are
  retried with backoff on subsequent runs, indefinitely, and surfaced in `report`
  after N failures. A presigned URL that expired mid-download is re-fetched,
  not treated as a failure of the recording.
- FR1d. **Periodic full reconciliation.** `plaudport pull --reconcile` (and the
  scheduler, weekly) lists the entire library and diffs it against the ledger;
  anything in Plaud and not in the ledger is a P1 defect in discovery and is
  logged as such, not silently added.
- FR2. Source adapters behind one interface: `plaud-mcp` (default), `plaud-web`
  (existing reverse-engineered client), `file` (drop folder), `share` (existing).
- FR3. `mark_memo` highlights (device button presses) are preserved as first-class
  markers on the recording and surfaced to the summarizer.

### Transcribe
- FR4. `plaudport transcribe [<id>|--pending]` runs the configured engine and
  writes a normalized transcript: utterances with start/end, words with
  timestamps where the engine provides them, language, engine + model + version.
- FR5. Engines behind one interface; v2 ships: `parakeet-mlx` (NVIDIA Parakeet
  TDT 0.6B v3, English-strong, fastest), `whisper-mlx` (large-v3-turbo,
  multilingual), and cloud opt-ins `elevenlabs-scribe` and `assemblyai`. Cloud
  engines are disabled unless `PLAUDPORT_ALLOW_CLOUD_STT=true` **and** the run
  passes `--cloud`, so a config mistake cannot ship audio off the machine.
- FR6. Per-recording engine override and an `--ab` mode that runs two engines
  and stores both, for the D7 evaluation.

### Diarize + identify
- FR7. Diarization via pyannote (`speaker-diarization-community-1`, MLX/CoreML
  path where available), producing speaker turns merged onto the transcript.
- FR8. **Voice library.** `plaudport voices enroll "<name>" <audio> [--from <id>
  --speaker SPEAKER_01]` extracts an embedding and stores it locally.
  `plaudport voices list|rename|remove|merge`. Identification assigns a name when
  cosine similarity clears a configurable threshold; otherwise the speaker stays
  `Speaker N` and is listed under "unidentified" so it can be enrolled with one
  command from a known recording.
- FR8a. **Never guess a name.** Identification is embedding-only; the pipeline
  never infers a speaker's identity from names spoken in the transcript, from
  calendar attendees, or from an LLM. Every assigned name carries its similarity
  score; the summarizer receives names only above threshold and is instructed
  to treat `Speaker N` as unknown, not to resolve it. This is the direct answer
  to the 2026-10-27 misattribution in §1.
- FR8b. A near-miss (second-best match within a configurable margin of the best)
  is reported as ambiguous and left unnamed rather than resolved by the higher
  score alone.
- FR8c. **Speaker assignments are versioned and corrections propagate.** Each
  recording stores an `assignments` record (diarized speaker → voice-library id
  or null, score, runner-up id + score, library version, assigned_at, and
  `source: auto | manual`). Any change to the voice library (`enroll`, `rename`,
  `merge`, `remove`, threshold or margin change, re-enrollment) bumps the
  library version. **Diarized speaker embeddings are persisted per recording**
  so re-identification never requires re-running diarization, but they live in
  the protected biometric store (FR10), keyed by recording id, never in the
  archive.
- FR8c-i. **Scope of re-identification.** A library change can affect
  assignments that never referenced the changed voice: enrolling Jane can turn
  a confident John match into a near-miss (FR8b), and a threshold change moves
  unnamed speakers across the line in both directions. So on any library
  change, every `auto` assignment in the archive is **re-scored** against the
  new library from its stored embedding (cheap: a cosine per speaker per
  recording). A recording is marked **stale** only when re-scoring changes an
  outcome: a name gained, lost, or changed, or a confident match becoming
  ambiguous. `rename` is the one exception: it is a label change with no
  re-scoring, applied in place everywhere.
- FR8c-ii. **Manual corrections win and persist.** `plaudport speakers set <id>
  SPEAKER_01 "Jane"` (or `--unknown`) writes a `manual` assignment that
  re-scoring never overrides. It is cleared only by an explicit
  `speakers unset`, or by `voices remove` of that voice, which nulls both auto
  and manual assignments for it so the name is gone immediately. This is what
  acceptance criterion 4 means by "every derived identification". A manual
  correction also records the owner's label as enrollment evidence (FR9) only
  when the owner says so (`--enroll`), never implicitly.
- FR8d. **Downstream invalidation.** A stale recording's summaries, FTS index
  rows, Notion page and vault pages are flagged stale together. `publish`
  refuses to push a stale recording and `mcp` returns it with `stale: true` and
  the transcript's current names, never a cached summary carrying an old name.
  Regeneration of summaries stays explicit (FR13): `plaudport summarize --stale`
  lists and regenerates affected recordings in one command, so a correction is
  one command and one review, not a silent re-spend and not a lingering error.
- FR8e. **Already-published errors are withdrawn, not left standing.** Blocking
  the *next* publish is not enough when a wrong name is already on a Notion
  page or in the vault. In the same run that marks a recording stale, the
  publishers perform a cheap, LLM-free **retraction**: the recording's
  participant list and speaker labels are rewritten from the current
  assignments; summaries built on the old assignments are replaced by a visible
  notice ("Summary withdrawn on <date>: speaker attribution changed; regenerate
  with `plaudport summarize --stale`"), and the Notion page / vault frontmatter
  gets `stale: true`. People pages (FR17) lose the backlink from that recording
  when the name was removed or changed. When the owner regenerates, the
  retraction is replaced and the flag cleared. If a publisher is unreachable
  during retraction, the retraction is queued and `report` shows it as
  **outstanding**, so a reader-visible wrong name is never silently tolerated.
- FR9. Enrolling from a recording the owner already labelled is the primary
  path: the first run of a known meeting yields `Speaker 2 = Jane` in a minute of
  review; every later meeting with Jane is automatic.
- FR10. **One protected biometric store for every embedding.** The voice
  library (enrolled profiles) *and* the per-recording diarized speaker
  embeddings (FR8c) live together in
  `~/Library/Application Support/PlaudPort/biometric/`, owner-only, encrypted at
  rest with a key in the macOS Keychain, never under the repo, never under the
  archive root (which may be a synced or external volume), never in the vault,
  never published, never in a backup of the archive. The archive's
  `assignments.json` carries only the outcome (voice id or null, scores,
  source); the vectors it was computed from are not recoverable from it.
  - FR10a. An unenrolled speaker's embedding is biometric data about someone
    who never agreed to be enrolled, so it gets the strictest handling: it is
    retained only to make re-scoring possible, and `plaudport biometric prune
    [--older-than <period>]` (default retention: 90 days, configurable, `0` =
    keep only enrolled) drops unenrolled embeddings; a pruned speaker simply
    cannot be auto-named later without re-diarizing that recording.
  - FR10b. `voices remove` deletes the enrolled profile and, because enrolled
    embeddings may have been derived from recordings, any per-recording
    embedding that was used as enrollment evidence for it. Deleting a recording
    from the archive deletes its embeddings from the store in the same
    operation.
  - FR10c. Backups of the biometric store are separate from archive backups,
    opt-in, encrypted with the same key, and `doctor` reports if the store is
    found inside any configured backup or sync path. Export only via an
    explicit `biometric export` that warns and requires confirmation.
  - FR10d. §8's "what the voice library is" README section describes both
    halves of the store, so a reader of the public repo knows exactly what is
    kept about enrolled and unenrolled people, where, and for how long.

### Summarize
- FR11. `plaudport summarize [<id>|--pending] [--template <name>]` renders a
  prompt from `templates/*.md` (frontmatter: name, description, output schema) with
  the identified transcript, highlights, title and date, and calls Claude.
  Ships with: `meeting-notes` (default), `meddpic`, `account-update`,
  `action-items`, `one-liner` (for the Notion index row).
- FR12. Templates are the owner's; the summarizer stores template name + model +
  prompt hash with the output so a regenerate is reproducible.
- FR13. Summaries are generated once per template by default; regenerate is an
  explicit flag (`--regenerate <id>` or `--stale`, FR8d). No credits meter, but
  no silent re-spend either. A summary records the assignments version it was
  built from; a mismatch with the recording's current version is what makes it
  stale.

### Publish
- FR14. **Local store is canonical.** `<archive-root>/<YYYY>/<MM>/<id>-<slug>/`
  holds `audio.mp3`, `manifest.json` (pointer + hashes, FR14b), `plaud/`
  (whatever Plaud produced), and revision directories each containing
  `transcript.json`, `transcript.md`, `assignments.json`,
  `summary-<template>.md`. No embeddings (FR10). Index in SQLite. Canonical
  means it must be recoverable:
  - FR14a. `PLAUDPORT_ARCHIVE_ROOT` is configurable and may point at an external
    or synced volume; the default under the repo is for development only, and
    `doctor` warns when the archive root is on the boot volume with no backup
    configured.
  - FR14b. **Atomic recording revisions, not just atomic files.** Per-file
    temp-and-rename is necessary but not sufficient: an update that rewrites
    `transcript.json` and crashes before `summary-*.md` would leave a complete
    manifest pointing at a mixed revision. So a recording directory holds
    immutable revision subdirectories (`rev-0001/`, `rev-0002/`, …), each
    written in full (temp names, renamed, fsynced) before a single
    `manifest.json` at the recording root is atomically replaced to point at
    the new revision. `manifest.json` lists every artifact in the revision with
    its sha256; readers validate the referenced artifacts against the manifest
    and reject the revision (falling back to the previous pointer) on any
    mismatch. Audio is written once and referenced by all revisions, never
    rewritten. The manifest carries a `current` pointer **and a `history`
    list** of retained previous revisions (default 3), each with its artifact
    hashes, so fallback and `plaudport revisions revert <id> <rev>` work from
    the manifest alone. Cleanup, whether by a normal write or by
    `plaudport index rebuild`, removes only revision directories that are in
    neither `current` nor `history`; a directory not referenced by either is an
    aborted write and is safe to delete. Retention trimming (dropping the
    oldest history entry) happens in the same atomic manifest swap that adds a
    new revision, never as a separate pass that could race with a reader.
    **All mutators serialize under a single OS-held exclusive archive lock**
    (`pull`, `reconcile`, `index rebuild`, cleanup), so revision numbers cannot
    collide and no writer's cleanup can delete another writer's uncommitted
    revision. The lock is held by the kernel for the life of the process: it
    **stays held while the process is suspended** and is **released only on
    process exit** (clean, crash, or kill). There is therefore no moment when two
    processes both hold it and no user-space check-then-write to race — a merely
    slow or suspended backfill is never taken over, and a crashed one frees the
    lock for the next run even though its lock *file* remains. Age is never a
    takeover trigger. (Single-host writes are assumed; advisory locks are not
    relied on across machines.) A recording directory with **no committed
    manifest** is an *interrupted initialization*, completed or restarted under
    the lock — distinct from a *corrupt committed* manifest, which falls back to
    history or is reported corrupt. The `fsync` ordering is the crash-safety
    contract and must cover **each file, each nested artifact directory, the
    revision directory, the recording directory after every rename** (revision
    and manifest), **and each newly-created parent directory up to a
    pre-existing archive ancestor**, with audio made durable before the manifest
    that references it. File `fsync` + rename survives a **process crash**; the
    directory `fsync`s are what extend the guarantee to **power loss**, and the
    PRD does not call the archive power-loss-safe without them.
  - FR14c. **The index is derived.** `plaudport index rebuild` reconstructs the
    SQLite database and FTS index from manifests alone; the database is never
    the only copy of anything. Manifests carry sha256 for audio and transcripts.
    "Derived" names exactly the **recording state**: the `recordings` rows, the
    per-artifact readiness, and the sync-lag samples (all recomputable from
    manifests + each recording's persisted `firstSeenAt`). Observational
    run-history (`runs`, `defects`) is **not** reproduced by a rebuild and is not
    claimed to be; a from-scratch rebuild restores the archive's state, not its
    audit log. Any "identical after rebuild" test compares the derived tables
    only. **The manifest is the authority:** on any disagreement between a
    recording's manifest and its ledger row, the manifest wins, and the row is
    re-derived from it. Discovery is therefore **idempotent** — a recording whose
    manifest already exists is adopted, never re-initialized — so a crash between
    writing the initial manifest and updating the ledger is recovered by the next
    ordinary `pull`, not only by an explicit rebuild.
  - FR14d. **Verified restore.** `plaudport backup verify <path>` restores a
    sample of recordings from a backup location into a scratch root and checks
    hashes. Documented in `docs/BACKUP.md` before P6; §8's "Plaud as transit
    buffer" stance is not adopted until a restore has been exercised once.
  - FR14e. **Biometric-store key recovery.** The Keychain key is exportable once,
    at creation, as a recovery phrase the owner stores outside the Mac; without
    it a restored biometric store is unreadable, and the PRD treats that as the
    correct failure mode rather than storing the key beside the data.
- FR15. `plaudport publish --to notion` upserts one page per recording into a
  configured database (title, date, duration, participants, template summaries,
  link to local audio). Idempotent via a stored Notion page id.
- FR16. `plaudport publish --to vault <path>` writes Obsidian-compatible markdown
  (frontmatter + wikilinks per participant) into a folder the owner keeps as a
  **private GitHub repo**. PlaudPort writes files; the owner (or a `--git-commit`
  flag) commits. Audio is never written to the vault, only text.
- FR17. Participants become `people/<name>.md` pages in the vault with backlinks,
  which is what makes "every meeting with Jane" a one-click query in Obsidian and
  a one-call query over MCP.

### Serve
- FR18. `plaudport mcp` runs a local stdio MCP server over the archive:
  `list_recordings` (date/participant/text filters), `get_transcript`,
  `get_summary`, `search` (SQLite FTS5 over transcripts and summaries),
  `get_audio_path`, `list_people`. Read-only. Registered in Claude Desktop /
  Claude Code config by `plaudport doctor --install-mcp`.
- FR19. The server reports, per recording, which engine produced the transcript
  and whether Plaud's version also exists, so Claude can prefer the local one.

### Run
- FR20. `plaudport run` = pull → transcribe → diarize/identify → summarize →
  publish, pending items only. `plaudport schedule install` adds a launchd agent
  (default: hourly while on AC power). Failures surface as a macOS notification
  and in the web UI, never silently.
- FR21. `plaudport doctor` checks: Node, Python sidecar + models downloaded,
  Hugging Face token accepted for pyannote, ffmpeg, Plaud credentials and
  expiry, Keychain access, MCP registration, disk space.
- FR22. `plaudport report` writes a reconciliation CSV/JSON: every recording in
  Plaud vs. the archive, transcript status per engine, identified vs.
  unidentified speakers, publish status per destination.

## 6. Non-functional requirements

- NFR1. Local-first; loopback-only web UI; no hosted component.
- NFR2. **No audio leaves the Mac except to the cloud STT engine when explicitly
  double-enabled (FR5), and to Plaud via the optional `push`.** An outbound host
  allowlist (`PLAUD_ALLOWED_HOSTS`, extended per engine) is enforced for every
  request, as today.
- NFR3. Throughput target on M4 / 24 GB: a 60-minute recording fully processed
  (transcribe + diarize + identify) in under 5 minutes; a day's 3–4 hours in
  under 20. Parakeet and whisper-turbo on MLX are both well above real time;
  pyannote is the long pole.
- NFR4. Memory: engines run sequentially, not concurrently; peak under 8 GB.
- NFR5. Resumable and idempotent at every stage; sha256 + Plaud id as the key.
- NFR6. Secrets (Plaud headers, Notion token, cloud STT keys, Anthropic key,
  voice-library key) in Keychain or the owner-only credential store. Nothing in
  the repo, the archive manifests, or the vault.
- NFR7. Redaction defaults as today: logs and reports carry shapes, not content.

## 7. Architecture

```
Plaud Note Pro ─BT/Wi-Fi─▶ Plaud app ─▶ Plaud cloud
                                            │ (MCP get_file / web API)
                                            ▼
┌─ Mac ───────────────────────────────────────────────────────────────┐
│  plaudport (Node)                                                   │
│   pull ─▶ archive/ ─▶ transcribe ─▶ diarize+identify ─▶ summarize   │
│                │           │  Python sidecar (MLX): parakeet /     │
│                │           │  whisper-turbo / pyannote / embeddings │
│                │           ▼                                        │
│                │     biometric/ (Keychain-encrypted, outside archive) │
│                ▼                                                    │
│   SQLite index + FTS5 ─▶ publish ─▶ Notion │ vault (private repo)   │
│                        └─▶ mcp (stdio) ─▶ Claude Desktop / Code     │
└─────────────────────────────────────────────────────────────────────┘
```

- **Node host** (existing): CLI, web UI, credential sync, ledger, SSRF guard,
  publishers, MCP server (`@modelcontextprotocol/sdk`).
- **Python sidecar**: a pinned `uv`-managed venv under Application Support,
  exposing a small JSON-over-stdio protocol: `transcribe`, `diarize`, `embed`,
  `identify`. Node never imports ML; it drives the sidecar. Swappable for a
  Swift/CoreML sidecar later without touching the pipeline.
- **Engines**: `parakeet-mlx`, `mlx-whisper` / `whispermlx`, `pyannote.audio`
  (community-1) for diarization and embeddings. Apple's on-device
  `SpeechAnalyzer` (macOS 26+) is a candidate third local engine via a tiny
  Swift shim; worth a spike, not a dependency.
- **Store**: SQLite (`better-sqlite3`) with FTS5; files on disk as in FR14.
- **Repo layout**: `src/` (host) · `sidecar/` (Python) · `templates/` ·
  `publishers/` · `mcp/` · `docs/`.

## 8. Security and privacy

OWASP mapping in `PRD.md` §8 still applies. New in v2:

- **Biometric data.** Voice embeddings of colleagues and customers are
  biometric identifiers under Illinois BIPA and similar state laws, and likely
  under Coder's data policy. Mitigations: local-only, encrypted at rest,
  owner-only, explicit enroll command (nothing is enrolled automatically), easy
  `voices remove`, and a README section that says plainly what the library is.
  Enrolling customer voices is the owner's call per relationship; the default
  guidance is enroll yourself and colleagues, leave customers as `Speaker N`.
- **Customer audio and a third STT vendor.** Cloud engines are double-gated (FR5)
  and off by default. Each engine's data-retention terms are linked in
  `docs/ENGINES.md` before it is enabled.
- **Private GitHub repo as a vault.** Text transcripts of customer meetings on
  GitHub are still a third party holding customer content. Acceptable only with
  a private repo, no audio, and the owner's judgement on Coder policy; the vault
  publisher is opt-in and the Notion/local options exist precisely so it can be
  skipped.
- **What Plaud keeps.** Under the 2026-10 ToS, Plaud retains voiceprints with
  its own retention rule and may infer and share organization-level usage from
  the account's email domain. Neither is in this project's power to change, but
  both argue for (a) the Apple-relay sign-in already in use, (b) requesting
  deletion of Plaud-side voiceprints once the local library is proven, and
  (c) treating Plaud's cloud as a transit buffer, not an archive: once a
  recording is pulled and verified locally, nothing depends on it staying there.
- **Prompt-injection surface.** Transcripts are untrusted text; the summarizer
  wraps them as data, and the MCP server returns them as data. Nothing in a
  transcript can trigger a publish or a push.
- **Unattended runs** hold credentials; the launchd agent runs as the user with
  no elevated rights and inherits the Keychain ACL.

## 9. Milestones

- **P0 — Pull (1 week).** FR1–FR3 over the MCP; archive layout (FR14a–c);
  ledger; `report`. **Exit gate — complete-library access proven, not assumed:**
  (a) `list_files` paged with date filters returns the full library, verified by
  `--reconcile` against a count taken in the Plaud web app, on a library
  > 500 recordings; (b) a dense day (≥ 10 recordings) is discovered completely;
  (c) a presigned URL deliberately allowed to expire is re-fetched and the
  download completes; (d) a recording with no Plaud transcript lands as
  `plaud_text_pending` and later resolves; (e) a late-synced recording (device
  held offline for a day, then synced) is discovered by the overlap window.
  Only then: every recording since the chosen date is on disk with sha256.
- **P1 — Transcribe (1–2 weeks).** Sidecar + `parakeet-mlx` + `whisper-mlx`;
  normalized transcript; `--ab`. **Exit: measured against ground truth, not
  against Plaud.** Build a reference set: five recordings, one 5-minute excerpt
  each, hand-corrected by the owner (stored under `data/eval/`, gitignored).
  Report WER (word error rate) per engine *and* for Plaud's transcript on the
  same excerpts, in `docs/ENGINES.md`. Plaud is a baseline being measured, not
  the yardstick.
- **P2 — Diarize + identify (2 weeks).** pyannote; voice library; enroll-from-
  recording; FR8a–d. **Exit, on held-out data:** enrollment audio and evaluation
  recordings are disjoint (enroll from meetings A–C, evaluate on D–M). Four
  separate numbers, each with its own bar: DER (diarization error rate) ≤ 15%
  on the owner's hand-labelled reference excerpts; **false identification rate = 0** on evaluation
  recordings (a wrong name is the one unacceptable error); unidentified rate
  for enrolled speakers ≤ 10% of their speaking time; and no name assigned to
  any unenrolled participant. "As good as Plaud used to be" is not a criterion;
  these are.
- **P3 — Summarize + local store + MCP (1 week).** Templates, Claude calls,
  SQLite/FTS5, `plaudport mcp` registered in Claude. Exit: Claude answers "what
  did we commit to at X" from local data with Plaud MCP disconnected.
- **P4 — Publish (1 week).** Notion and vault publishers; people pages.
- **P5 — Run unattended + hardening (1 week).** launchd, notifications, `doctor`,
  OWASP pass, docs rewrite (README leads with v2; v1 share import demoted).
- **P6 — Downgrade decision.** After one full billing cycle of parallel running
  (D7), compare and decide. The pipeline is complete whether or not the plan
  changes.

### Gate after P2
If the P2 exit criteria are not met on the held-out set (false identification
rate above zero, unidentified rate for enrolled speakers above 10%, any name on
an unenrolled participant, or DER above **15%** on the owner's hand-labelled
reference excerpts; published figures for pyannote community-1 on public
benchmarks are context for whether 15% is reasonable, not the bar), pause and
reassess the engine (embedding model, threshold and margin, overlap handling)
before building P3+ on top. Speaker identity is the feature that justifies the
project; summaries without it are only a cheaper Plaud.

## 10. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Plaud restricts the MCP or audio URLs on Starter | Medium | Stay on a paid plan until P6; `plaud-web` adapter as fallback; archive is already local by then |
| Bearer expiry breaks unattended pulls | High | Existing Chrome sync; `doctor` warns on expiry; notification on failure; pulls are catch-up, nothing is lost |
| pyannote accuracy on 4+ speaker, cross-talk meetings | Medium | `--ab` evaluation in P2; threshold tuning; Plaud as control group |
| Python sidecar fragility (versions, Metal, HF gating) | Medium | `uv` with a lockfile; `doctor`; pinned model revisions |
| Biometric/privacy exposure of the voice library | Low–Medium | §8; local-only, encrypted, explicit enroll, easy remove |
| Scope creep toward "a Plaud replacement" | High | §3 Out list; no live transcription; the phone app stays |
| Owner time | High | Milestones are each a usable increment; P0+P1 alone already de-risk a downgrade |

## 11. Open questions

- **O1.** Does `list_files` paginate the full library? The MCP's current tool
  description says date filters are server-side and support `page`/`page_size`,
  and that only the name-substring `query` ignores paging (newest 500 scanned).
  That is the behaviour FR1a depends on, and it is an assumption until the P0
  exit gate proves it on this account's library.
- **O2.** pyannote community-1 on MLX vs. CoreML vs. CPU on the M4: which path,
  and what is the real-time factor? Resolve in P2 spike.
- **O3.** Embedding model for identification: pyannote's own vs. WeSpeaker /
  ECAPA-TDNN. Decide on measured accuracy in P2.
- **O4.** Notion target: existing meeting database or a new one? Owner decision
  before P4.
- **O5.** Vault repo: new private repo or a folder in an existing one? Owner
  decision before P4.
- **O6.** Does Coder policy permit transcripts of customer meetings in a private
  GitHub repo and/or Notion? Owner to confirm before enabling either publisher
  for customer recordings.
- **O7.** Is Apple's `SpeechAnalyzer` worth a third local engine? Spike, P1 or
  later. Same question for NVIDIA Nemotron ASR, which the community is already
  trying as a local Plaud replacement.
- **O8.** Can Plaud-side voiceprint data be deleted on request while keeping the
  account? Ask support once P2 passes its gate.

## 12. Acceptance criteria

1. With the Plaud MCP disconnected from Claude, every recording since the chosen
   start date is reachable through `plaudport mcp` with a local transcript, named
   speakers where enrolled, and at least one summary.
2. A new recording made on the Note Pro appears in the local store, transcribed,
   identified, summarized and published, within one scheduled run, with no
   manual step beyond the phone app syncing it.
3. No audio has left the Mac except to Plaud, verified by the allowlist log,
   unless cloud STT was double-enabled for a specific run.
4. The voice library contains only explicitly enrolled people, is encrypted,
   and `voices remove` deletes an entry, nulls every assignment that referenced
   it, re-scores all other auto assignments, marks every affected summary,
   index row and published page stale, retracts the name from already-published
   pages in the same run, and `publish` refuses them until regenerated. Manual
   corrections to other speakers survive untouched.
4a. Enrolling a new voice re-scores every existing auto assignment; a match
   that becomes ambiguous under FR8b is unnamed and its recording marked stale.
5. The reconciliation report shows zero recordings in Plaud missing from the
   archive, including a recording synced a day late and one whose first
   download failed.
5a. `plaudport index rebuild` from manifests alone reproduces the index, and a
   restore from the backup location has been exercised and hash-verified once.
6. `npm test`, `npm run typecheck`, `npm run check:secrets`, and the sidecar
   tests pass in CI.

## 13. Defaults to validate

Every number below is a starting guess chosen to make the requirement concrete,
not a measured result. Each is a config value with the name shown, and each has
a named milestone where evidence replaces the guess. Changing one is a PRD edit
with a changelog line, not a silent config tweak.

**Three classes of evidence, kept separate.** (a) *Automated tests* run without
a Plaud account and prove logic. (b) *Live-account verification* runs against
the owner's real library and proves behaviour that cannot be simulated
(paging over > 500 recordings, presigned-URL expiry, late device sync). (c)
*Ongoing calibration* replaces a default with measurements taken over days or
weeks. The "Validate in" column names the milestone that **installs the
measurement**; where the method needs a month of observation, the milestone's
exit records the default as *pending calibration* with the measurement in
place, not as validated. Milestone exit gates (§9) may be met with (a) + (b);
no (c) item blocks a gate. Every plan and PR lists each check with its class,
its prerequisites (credentials, library size, elapsed time), and, if not yet
performed, **pending** plus who runs it and when. A simulated check is never
recorded as live verification.

| Default | Value | Config | Where it is in the PRD | Validate in | How |
|---|---|---|---|---|---|
| Discovery overlap window | 14 days | `PLAUDPORT_PULL_OVERLAP_DAYS` | FR1a | P0 | Measure the longest observed gap between `start_at` and first appearance in `list_files` over a month; set to 2× that |
| Plaud-text pending age-out | 7 days | `PLAUDPORT_PLAUD_TEXT_TIMEOUT_DAYS` | FR1b | P0 | Observe how long Plaud takes to attach a transcript; if it never exceeds 48 h, shorten |
| Retry escalation threshold | N = 3 failures before `report` flags | `PLAUDPORT_RETRY_REPORT_AFTER` | FR1c | P0 | Tune so transient CDN errors do not page the owner but real breakage does within a day |
| Cloud STT double gate | env + `--cloud` | `PLAUDPORT_ALLOW_CLOUD_STT` | FR5 | P1 | Not a number; confirm no code path reaches a cloud engine without both |
| Identification similarity threshold | engine-dependent, start 0.70 cosine | `PLAUDPORT_ID_THRESHOLD` | FR8 | P2 | Sweep on the held-out set; pick the highest threshold that keeps unidentified rate ≤ 10% with zero false identifications |
| Ambiguity margin | 0.05 cosine | `PLAUDPORT_ID_MARGIN` | FR8b | P2 | Same sweep; count near-misses that would have been wrong names |
| Unidentified rate for enrolled speakers | ≤ 10% of speaking time | — (exit bar) | P2 exit, gate | P2 | If the sweep cannot reach 10% at zero false IDs, the bar moves and the PRD says why |
| DER bar | ≤ 15% | — (exit bar) | P2 exit, gate | P2 | Measured on the owner's labelled excerpts; published pyannote figures are context |
| Unenrolled-embedding retention | 90 days | `PLAUDPORT_BIOMETRIC_RETENTION_DAYS` | FR10a | P2–P3 | Count how often an unenrolled speaker from > 30 days ago gets enrolled later; if rarely, shorten toward 30 |
| Retained revisions | 3 | `PLAUDPORT_REVISION_HISTORY` | FR14b | P3 | Check whether any revert ever needed more than 1 |
| Reference-set size | 5 recordings × 5-min excerpts | — | P1 exit | P1 | If WER variance across excerpts is high, grow the set before trusting the number |
| Held-out evaluation set | enroll on 3 meetings, evaluate on 10 | — | P2 exit | P2 | Grow until false-ID rate has been zero across at least 20 distinct speaker-turns per enrolled person |
| Throughput target | 60-min recording < 5 min; 3–4 h/day < 20 min | — (NFR3) | NFR3 | P1–P2 | Measure on the M4; if pyannote is the long pole, that decides the O2 engine-path question |
| Peak memory | < 8 GB | — (NFR4) | NFR4 | P1–P2 | Measure with engines sequential; if exceeded, smaller models before concurrency changes |
| Scheduler cadence | hourly on AC power; weekly `--reconcile` | `PLAUDPORT_SCHEDULE_*` | FR20, FR1d | P5 | Compare pull latency against how soon the owner actually wants notes |

## References

- Plaud: Ask Plaud Chat vs. Work (credits) — https://www.plaud.ai/blogs/news/ask-plaud-chat-work
- Plaud: AI Membership FAQ (plans, minutes, top-ups) — https://support.plaud.ai/hc/en-us/articles/57724862694937-Plaud-AI-Membership-FAQ
- Plaud: Transcription minutes (Starter keeps syncing) — https://support.plaud.ai/hc/en-us/articles/11177116525455-Transcription-minutes
- Plaud: NotePin S no USB access — https://support.plaud.ai/hc/en-us/articles/53788775968409
- Plaud: recordings not accessible via charging cable — https://support.plaud.ai/hc/en-us/articles/50153604465177
- Plaud: Note "Access via USB" toggle (original Note only) — https://support.plaud.ai/hc/en-us/articles/8127779432079
- Plaud MCP docs — https://docs.plaud.ai/plaud-mcp-cli/mcp
- whispermlx (WhisperX on MLX, pyannote diarization) — https://pypi.org/project/whispermlx/
- parakeet-mlx — https://github.com/EliFuzz/parakeet-mlx
- Speaker diarization on Apple Silicon (pyannote / Sortformer / Nemotron) — https://soniqo.audio/guides/diarize
- r/PlaudNoteUsers, "Enshittification of Plaud with 4.0 and recent updates" (2026-10-29) — https://www.reddit.com/r/PlaudNoteUsers/s/oV9quEQ1sL
- Prior PRDs in this repo: `PRD.md` (Team consolidation), `PRD-SHARE-IMPORT.md`
