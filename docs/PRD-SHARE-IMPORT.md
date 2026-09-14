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

## 4. The gate: what does a share link actually expose? (**O-S1**)
Everything depends on this, and it is unverified. `npm run probe:share` answers it.

| Outcome | What it means | Path |
|---|---|---|
| **A. Audio + transcript both fetchable** | Best case. Full fidelity import. | Build as specified. |
| **B. Transcript only, no audio** | D1 is impossible as stated. Either import a text-only item (if Plaud allows one) or hold the transcript locally. **Stop and re-decide with the owner.** |
| **C. Neither — rendered page only** | Would require scraping rendered HTML, which is brittle and breaks on every redesign. **Stop and re-decide.** |

Per the O1 rule inherited from `PRD.md`: no browser automation fallback without
explicit approval.

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
1. `npm run probe:share -- <link>` reports what the link exposes, without printing meeting content.
2. Given a working link, one command lands the recording in Personal with its original transcript attached.
3. The Plaud MCP can find that recording afterwards — verified, not assumed.
4. Re-running the same link changes nothing and says so.
5. A local backup of audio + transcript exists before anything is written to Plaud.
6. Nothing in the repo or its reports ever contains the share token or meeting content.

## 9. Milestones
- **S0 — Probe (now).** `probe:share` + `shareUrl` parsing. Resolves O-S1. ✅ built, awaiting a run on a real link.
- **S1 — Fetch + backup.** Resolve a share to audio/transcript/summary and archive it locally. Read-only; safe to build as soon as S0 answers A.
- **S2 — Import.** Upload audio into Personal. Needs the `importAudio` endpoint; shared with `PRD.md` M0.
- **S3 — Attach + verify.** Original transcript onto the item; MCP-verified.
- **S4 — Local web UI.** Paste a link, click Import, watch progress (D4).
