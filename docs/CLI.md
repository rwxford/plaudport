# Terminal commands

For the recommended browser interface, start with the [README](../README.md).
These commands are for people who prefer Terminal or need local audio/video imports.
Run them from your PlaudPort folder.

## Quick start

```bash
npm install
npm run import -- "https://web.plaud.ai/s/pub_xxxxxxxx::xxxxxxxx"
```

One command: archives the meeting locally, then uploads it into your Plaud
Personal workspace keeping its **original title and recording date**. The same
command takes a file of links, or any mix — see below.

Uploading needs credentials from [Chrome sync](../README.md#set-up-once)
or `.env` (`docs/UPLOAD-API.md`); archiving needs nothing at all, since a share link is its own authorisation. To archive without
uploading, add `--fetch-only`:

```bash
npm run import -- "<link>" --fetch-only
```

Either way you get, under `data/shares/<share-id>-<title>/`:

- `audio.mp3` — the recording, checksummed
- `transcript.txt` — the original transcript, `[mm:ss] Speaker: text`
- `transcript-polished.txt` — Plaud's AI-cleaned version
- `recording.md` — title, date, length, summary, outline and both transcripts in
  one readable document
- `detail.json` + `manifest.json` — the raw response and an integrity record

Re-running is safe: audio already archived is verified by checksum and not
re-downloaded, and a recording already imported is not uploaded twice. Pass
`--extra-copy` when a second copy is genuinely what you want.

## Several links at once

The same `import` command. Put the links in a file, one per line — `#` comments
and blank lines are fine, so it doubles as a working list:

```
# AWS Federal AI Symposium, 09-15
https://web.plaud.ai/s/pub_aaaa…::tok
https://web.plaud.ai/s/pub_bbbb…::tok
```

```bash
npm run import -- links.txt                       # archive + import each
npm run import -- links.txt "https://…" "https://…"   # any mix of files and links
npm run import -- links.txt --fetch-only          # archive only, no upload
npm run import -- links.txt --extra-copy          # re-import ones already done
```

Each link is archived locally and then uploaded, keeping its original title and
recording date. Ten links takes one command and a few minutes.

- **Already imported links are skipped**, so re-running is safe and cheap.
- **One bad link doesn't sink the run** — every link is attempted, and the
  summary at the end names the ones that need attention.
- **The credential is checked once up front**, so an expired token stops the run
  before anything uploads rather than on link 9 of 12. If it expires mid-run, the
  run stops and says so; reload your signed-in Plaud page to sync fresh
  credentials, then re-run. `npm run set:auth` remains the manual fallback.
- A JSON report of every run lands in `data/runs/`.

## A Gong call, or any recording on disk

Still the same `import` command. Download the call from Gong (**⋮ → Download**),
then:

```bash
npm run import -- ~/Downloads/"Acme discovery.mp4" --title "Acme discovery" --date "2026-09-20 14:00"
```

It converts MP4/WAV to MP3 (needs ffmpeg), archives it under `data/imports/`,
and uploads it dated when the call happened. **Pass `--date`**: a download's
own timestamp is the day you downloaded it, and the command warns you if that's
all it has. The same file, even renamed, is only ever imported once.
`~/Downloads/*.mp4` imports several at once. Details, and the plan for fetching
from Gong automatically, are in [Gong import guide](GONG.md).

## Pull your whole Plaud library to this Mac (v2)

PlaudPort v2 keeps a local archive of every recording — audio plus whatever
Plaud produced (transcript, polished transcript, outline, highlights, summary)
— with sha256 checksums, as the system of record
([`PRD-PIPELINE.md`](PRD-PIPELINE.md)). It reads through Plaud's **official**
MCP package, which handles sign-in and token refresh; nothing is ever changed
or deleted in Plaud.

```bash
plaudport doctor --install-mcp   # once: pins Plaud's MCP package, then checks everything
plaudport login                  # once: Plaud's own sign-in opens in your browser
plaudport doctor                 # all green?
plaudport pull --all             # FIRST run: backfill the whole library (long — an hour+ for 1,000 recordings)
plaudport pull                   # every run after: new recordings + anything still pending
```

**The first archive needs `--all` (or `--since 2025-06-01`).** A bare `pull`
only reaches back `PLAUDPORT_PULL_OVERLAP_DAYS` (default 14) from the newest
recording already archived — that overlap is what catches a recording the
phone syncs a day late.

Re-running is always safe: recordings are tracked by id, a failed download is
retried on the next run (with backoff, indefinitely), and Plaud's transcript
and summary are collected whenever they appear, each as a new revision.

| Command | What it does |
|---|---|
| `plaudport pull --since 2026-10-15 --until 2026-10-15 --dry-run` | Count one day's recordings without writing anything (compare with the Plaud app) |
| `plaudport pull --reconcile` | List the whole library; anything missing from the archive is reported as a **discovery defect** (exit code 2) and then archived |
| `plaudport pull --recheck-text --all` | Ask Plaud again for transcripts/summaries that timed out (e.g. after minutes refresh) |
| `plaudport report --lag` | Archive state, failing downloads, and how late recordings sync (to tune the overlap window) |
| `plaudport report --verify-audio 20` | Re-hash a random sample of archived audio against the recorded sha256 |
| `plaudport index rebuild` | Rebuild the index from the archive's manifests alone |

Exit codes for `pull`: `0` ok · `1` error · `2` discovery defects ·
`3` archive busy (another pull is running) · `4` Plaud sign-in needed.

The archive lives at `PLAUDPORT_ARCHIVE_ROOT` (default `./data/archive`,
gitignored): `<YYYY>/<MM>/<recording-id>/` holds `audio.mp3`, a `manifest.json`
with checksums, and immutable `rev-NNNN/` revisions. Point it at a volume you
back up — `doctor` warns until `PLAUDPORT_BACKUP_HINT` says you have one. Logs
and reports carry counts and states only, never titles or ids.
