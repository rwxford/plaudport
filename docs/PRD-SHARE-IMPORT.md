# PRD — Share-Link Import ("bring a shared meeting into my Plaud")

**Status:** Draft v1 · **Owner:** Ross Weatherford (rwxford) · **Priority:** primary
(the Personal→Team consolidation work in `PRD.md` is now secondary)

## 1. Problem
Someone sends you a Plaud public share link:

```
https://web.plaud.ai/s/pub_<uuid>::<access-token>
```

It opens a read-only web page. The recording lives in *their* Plaud account, not
yours — so it is invisible to your Plaud MCP, absent from your library, and gone
the day they revoke the link. There is no "save to my Plaud" button.

## 2. Goal
One command (later, one paste into a local web page) that takes a share link and
lands that meeting in **your Personal workspace as a real recording** — audio plus
the original transcript — indistinguishable from something you recorded yourself,
and therefore reachable by the Plaud MCP from Claude.

### Decisions (2026-09-14)
| # | Decision |
|---|---|
| D0 | Source side is solved without credentials (2026-09-14); the open question is only whether Plaud accepts an upload. |
| D1 | Target shape is a **real recording**: audio + transcript, not a text note. |
| D2 | Links come from **other people's accounts**; a public link is all we get. No source-side login. |
| D3 | **One link at a time**, on demand. No batch, no watcher, no inbox scraping — yet. |
| D4 | **CLI first** to prove the mechanism, then wrap it in the local web UI. |

## 3. Scope
**In:** parse a share link · fetch its audio + transcript + summary + metadata ·
back it up locally · import the audio into Personal · attach the original
transcript · verify · report.

**Out (for now):** batch import, watching a channel for links, importing to Team
(that is `PRD.md`), editing or re-sharing anything, any write to the *source*
account.

> **Confirmed working against the live API on 2026-09-15**: one command returned a
> 10m 35s meeting — 9.3 MB of audio, 35 transcript utterances, 35 polished, a
> 25-topic outline and its notes. The API additionally requires the web app's
> request headers (see `docs/SHARE-API.md`); without them it answers 403.

## 4. What a share link exposes (**O-S1 — ANSWERED, 2026-09-14: outcome A**)
Settled by a HAR capture of the real page. Plaud's share API is **unauthenticated**
— the link is the credential — and returns everything but the audio bytes in one
call, with a second call handing over a presigned S3 URL for the audio. Full
shapes in `docs/SHARE-API.md`.

| | Status |
|---|---|
| Audio | **Available** — single mp3, presigned, no HLS segments |
| Transcript | **Available** — original *and* AI-polished, with speakers and timestamps |
| Outline + notes/summary | **Available** |
| Title, date, duration, language | **Available** |
| Auth required | **None** |
| Uploading into Plaud | **Unproven** — shared with `PRD.md` M0 |

This is the best case in the original gate: D1 (a real recording with audio and
transcript) is achievable on the *source* side. Only the destination side is open.

### The fallback is the floor, not a consolation
If the upload path turns out to be impossible, the owner still gets the mp3 on
disk and imports it by hand through Plaud Web. So **the local audio file is the
primary deliverable** and automated import is the stretch. Work is ordered
accordingly: nothing downstream blocks on the unproven write path.

Per the O1 rule inherited from `PRD.md`: no headless-browser fallback without
explicit approval. Capturing a media URL from a HAR is not browser automation —
it is reading one request the browser already made.

## 5. Pipeline (once O-S1 resolves as A)
1. **Parse** — `src/shareUrl.ts`, already built and tested: splits `pub_<uuid>::<token>`, rejects non-Plaud hosts, never logs the full token.
2. **Resolve** — fetch the share's metadata: title, date, duration, speakers, transcript, summary, audio URL.
3. **Back up** — write audio + transcript + summary + `manifest.json` under `data/shares/<shareId>/` *before* any write to Plaud. Same backup-before-migrate rule as the migration tool.
4. **Import** — upload the audio into Personal via the web API (the `importAudio` endpoint from M0). This is the same unproven write path the migration project needs; whichever project proves it first unblocks the other.
5. **Attach derived data** — write the original transcript/summary onto the new item (`FR11b` preference order from `PRD.md`). Regeneration stays opt-in; the original is never replaced.
6. **Verify** — confirm via the **official Plaud MCP** (`list_files` / `get_file` / `get_transcript`) that the item exists in Personal with the expected duration. This is the one step that needs no reverse-engineering, and it is how "it worked" gets proven rather than assumed.
7. **Report** — per-run record: share id, target file id, integrity, what was attached, what failed.

## 6. Idempotency
Re-running the same link must not create a second copy. Ledger key: `shareId`,
plus `sha256(audio)` once audio is in hand — so the same meeting shared under two
different links still dedupes.

## 7. Security & etiquette
- The **share token is a credential** for that one recording. Never logged in full
  (`describeShare` masks it), never committed — `data/` is gitignored.
- Probe output reports **structure, not content**: someone else's meeting is not
  ours to paste into a terminal, a report, or a chat. `--raw` exists for local
  debugging and says so loudly.
- Only hosts in `PLAUD_ALLOWED_HOSTS` are contacted, including for media and
  script URLs discovered on the page.
- **No writes to the source account, ever.** Read-only at the source, exactly like
  the copy-only invariant in `PRD.md`.
- Consideration, not a blocker: importing a meeting someone shared with you puts a
  copy in your account. The link-holder shared it deliberately, but content and
  participants belong to the sharer — treat a revoked link as a signal to delete
  your copy.

## 8. Acceptance criteria
| # | Criterion | Status |
|---|---|---|
| 1 | `probe:share` reports what a link exposes without printing meeting content | ✅ |
| 2 | One command lands the recording in Personal | ⚠️ two commands (`fetch:share`, `import:audio`), and the **audio only** — the original transcript is archived locally but not attached to the Plaud copy |
| 3 | The Plaud MCP finds that recording afterwards — verified, not assumed | ✅ 2026-09-16 |
| 4 | Re-running the same link changes nothing and says so | ✅ both: `fetch:share` verifies by checksum and skips, `import:audio` refuses a second upload unless `--extra-copy` is passed |
| 5 | A local backup of audio + transcript exists before anything is written to Plaud | ✅ |
| 6 | Nothing in the repo or its reports contains the share token or meeting content | ✅ |

Remaining rough edge: the bearer token expires daily and is refreshed by hand
(`npm run set:auth` makes that one command). Unattended renewal needs a login or
refresh endpoint that has not been captured — see `docs/UPLOAD-API.md`.

## 9. Milestones
- **S0 — Probe.** `probe:share` + share-link parsing. ✅ built and tested.
- **S1 — Get the audio out.** ✅ `fetch:audio --from-scan` streams a media URL to
  disk with size + sha256 verification. Now the fallback route, since S1b covers
  the normal case.
- **S1b — Full archive from the link alone.** ✅ `fetch:share` calls the share API
  directly: audio, both transcripts, outline, notes, metadata, an integrity
  manifest and a readable markdown archive. Idempotent. **This satisfies the
  fallback in full** — hand-import the mp3 and nothing is lost.
- **S2 — Import.** ✅ **Done and verified against live Plaud (2026-09-16).**
  `import:audio` runs the four-step upload (presign → PUT 5 MiB parts → merge →
  confirm), keeping the original title and recording date. Confirmed through the
  official MCP: the recording exists with the right title, dated 2026-09-14 as
  the meeting was, checksum matching the local copy.
- **S3 — Attach + verify.** ✅ Verification via the official MCP works.
  **Attaching the original transcript is still open, and still worth doing.**
  An imported recording arrives as audio only; transcription is owner-initiated
  in Plaud and presumably costs plan minutes. Writing the share's own transcript
  onto the imported file would save that step and preserve the original wording
  rather than producing a second, different transcript of the same audio.
  **Closed as not possible (2026-09-16):** Plaud offers no way to supply your own
  transcript, not even manually in the web app. There is therefore no endpoint to
  find. An imported recording is audio; transcription is Plaud's to produce, on
  request, at whatever it costs in plan minutes. The share's original transcript
  stays in the local archive and is the fuller record of the two.
- **S4 — Local web UI.** Paste a link, click Import, watch progress (D4).
- **S5 — HLS support (conditional).** Only if the audio turns out to be segmented;
  needs ffmpeg. Skipped otherwise.
