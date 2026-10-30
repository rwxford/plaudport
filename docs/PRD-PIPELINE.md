# PRD — Plaud as Capture Device, Everything Else Local ("PlaudPort v2")

**Status:** Draft v1 for review (2026-10-29) · **Owner:** Ross Weatherford (rwxford) ·
**Priority:** primary. Supersedes `PRD-SHARE-IMPORT.md` as the main line of work;
share import and the upload path (`UPLOAD-API.md`) become sub-features of this one.

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
- FR1. `plaudport pull [--since <date>] [--all]` lists recordings newer than the
  ledger's high-water mark, downloads audio to the archive, and stores Plaud's
  transcript/summary/highlights alongside when they exist. Idempotent; resumable;
  sha256 recorded; never mutates Plaud.
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
- FR9. Enrolling from a recording the owner already labelled is the primary
  path: the first run of a known meeting yields `Speaker 2 = Jane` in a minute of
  review; every later meeting with Jane is automatic.
- FR10. The voice library lives in `~/Library/Application Support/PlaudPort/voices/`
  with owner-only permissions, encrypted at rest with a key in the macOS Keychain,
  never under the repo, never in the vault, never published. Export only via an
  explicit `voices export` that warns.

### Summarize
- FR11. `plaudport summarize [<id>|--pending] [--template <name>]` renders a
  prompt from `templates/*.md` (frontmatter: name, description, output schema) with
  the identified transcript, highlights, title and date, and calls Claude.
  Ships with: `meeting-notes` (default), `meddpic`, `account-update`,
  `action-items`, `one-liner` (for the Notion index row).
- FR12. Templates are the owner's; the summarizer stores template name + model +
  prompt hash with the output so a regenerate is reproducible.
- FR13. Summaries are generated once per template by default; regenerate is an
  explicit flag. No credits meter, but no silent re-spend either.

### Publish
- FR14. **Local store is canonical.** `data/archive/<YYYY>/<MM>/<id>-<slug>/` holds
  `audio.mp3`, `transcript.json`, `transcript.md`, `summary-<template>.md`,
  `plaud/` (whatever Plaud produced), `manifest.json`. Index in SQLite.
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
│                │     voices/ (Keychain-encrypted)                   │
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

- **P0 — Pull (1 week).** FR1–FR3 over the MCP; archive layout; ledger; `report`.
  Exit: every recording since a chosen date is on disk with sha256 and Plaud's
  transcript where present.
- **P1 — Transcribe (1–2 weeks).** Sidecar + `parakeet-mlx` + `whisper-mlx`;
  normalized transcript; `--ab`. Exit: WER (word error rate) spot-check on five
  recordings against Plaud's transcript, measured, written up in `docs/ENGINES.md`.
- **P2 — Diarize + identify (2 weeks).** pyannote; voice library; enroll-from-
  recording. Exit: on ten meetings with known participants, named-speaker
  accuracy ≥ Plaud's former voice-profile behaviour as the owner remembers it,
  and no false positive on an unenrolled customer.
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
If local named-speaker accuracy is clearly worse than what Plaud had, pause and
reassess the engine (embedding model, threshold, overlap handling) before
building P3+ on top. Speaker identity is the feature that justifies the project;
summaries without it are only a cheaper Plaud.

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

- **O1.** Does the Plaud MCP's presigned URL work for recordings older than the
  newest 500, and does `list_files` paginate the full library? Resolve in P0.
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
   and `voices remove` deletes an entry and every derived identification.
5. The reconciliation report shows zero recordings in Plaud missing from the
   archive.
6. `npm test`, `npm run typecheck`, `npm run check:secrets`, and the sidecar
   tests pass in CI.

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
