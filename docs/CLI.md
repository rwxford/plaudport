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
