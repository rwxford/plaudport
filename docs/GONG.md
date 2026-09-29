# Gong → Plaud

Get a call recorded in Gong into your Plaud Personal workspace, where the
Plaud MCP can reach it alongside everything else.

| Phase | What | Status |
|---|---|---|
| **1** | You download the recording from Gong by hand; `npm run import` does the rest | ✅ built, tested against a stand-in Plaud |
| **2** | PlaudPort fetches the recording from Gong itself | Planned, blocked on API access ([#2](https://github.com/rwxford/plaudport/issues/2)) |

> **Whose data is this?** A Gong recording is a customer call, captured under
> your company's agreement with Gong and its customers' consent. Copying it into
> a personal Plaud account puts it with another vendor. Check that your
> company's data policy allows that before you do it at scale.

## Phase 1 — download by hand, import with one command

### 1. Download from Gong

Open the call in Gong → **⋮** (top right) → **Download**. Choose **Audio** if it
is offered: it's smaller, and Plaud only keeps the audio anyway. **Video** works
too.

If **Download** isn't in the menu, your Gong permission profile doesn't include
it, and only a Gong admin can change that.

### 2. Import it

```bash
npm run import -- ~/Downloads/"Acme discovery.mp4" --title "Acme discovery" --date "2026-09-20 14:00"
```

- **`--date`** is when the call happened, as a local date and 24-hour time
  (`2026-09-20` alone means midnight). **Pass it.** Without it the only date on
  hand is the file's own timestamp, which is when you *downloaded* the file, so
  Plaud would file the call under today. The command warns you when that
  happens.
- **`--title`** defaults to the filename.
- **ffmpeg** is required for anything that isn't already an MP3, which covers
  both of Gong's formats: `brew install ffmpeg`. Plaud's upload has only been
  proven with MP3, so everything is converted to MP3 first. That also shrinks
  the upload: an hour of CD-quality WAV is about 600 MB, while the MP3 is
  under 80.

Several downloads at once work too. Each is then titled after its filename, so
rename the files first if you care about the titles:

```bash
npm run import -- ~/Downloads/*.mp4
```

It's the same `import` command used for Plaud share links, so a single run can
mix share links, files of links and Gong downloads.

### What you get

Under `data/imports/<checksum>-<title>/`:

- `audio.mp3`, the converted recording that was uploaded
- `manifest.json`, recording the original file's name, size and checksum, the
  title, the date and where it came from, the duration, and the Plaud file id
  once it's imported

In Plaud, the recording arrives as **audio only**, just like a share import, and
you ask Plaud to transcribe it. Gong's own transcript isn't imported. Plaud
provides no way to supply one.

### Re-running is safe

Recordings are recognised **by content** (a SHA-256 of the original file), not by
filename. Importing the same download twice, or a renamed copy of it, reports
`Already in Plaud as of_…` and uploads nothing. Pass `--extra-copy` if you
genuinely want a second copy.

### Tested, and what isn't yet

`npm run demo` (step 5) converts a WAV and uploads it to a stand-in Plaud, then
checks that what arrived is an MP3, that it carries the given title, that it's
dated with `--date` in local time, that a renamed copy is recognised, and that
the warning appears when there's no date. Unit tests cover date parsing,
argument handling and the conversion, including a video with no audio track.

**Not yet seen:** a real Gong download. Two things are worth checking on the
first one:

1. **What Gong names the file.** If the filename reliably contains the call
   title and date, the tool can read them from it and `--date` stops being
   necessary. Report the *pattern* (swap the customer's name for `<customer>`),
   not the real name.
2. **Whether the MP4 carries a creation date.** The tool uses one if present
   (shown as `from file metadata`). It could be the call time or just the
   export time. Compare it with the date of the call.

## Phase 2 — fetch from Gong automatically

### The mechanism exists, officially

Unlike Plaud, Gong has a documented public API:

- `POST /v2/calls/extensive` returns call metadata (title, start time, duration,
  participants). It filters by date range, call ids or host.
- With `contentSelector.exposedFields.media: true`, each call also carries
  `media.audioUrl` / `media.videoUrl`, presigned URLs that expire after **8
  hours**.
- `POST /v2/calls/transcript` returns the transcript. Plaud can't accept it, but
  it's worth archiving locally, as share imports already do.
- The base URL is per company (`https://<region>-<n>.api.gong.io`).

That gives the correct **title and date with no guessing**, which is the main
weakness of Phase 1.

### Intended shape

Keep one command. A Gong call link becomes one more kind of input:

```bash
npm run import -- "https://us-1234.app.gong.io/call?id=1234567890"
npm run import -- --gong-since 2026-09-01          # every call you hosted since then
```

Internally: call id → `/v2/calls/extensive` → download `audioUrl` → the Phase 1
pipeline, with Gong's title and start time in place of `--title`/`--date`.
Dedupe on the Gong call id as well as the checksum.

### The blocker: getting a credential

Gong's API authenticates with either:

1. **An access key + secret**, generated by a Gong *technical admin* under
   Company Settings → API. Such a key reads **every call in the company**, not
   just yours, so it's a big ask for one person's convenience, and whoever holds
   it holds all of it.
2. **An OAuth app**, with scopes `api:calls:read:extensive` +
   `api:calls:read:media-url`. It still needs an admin to install it, and the app
   must be registered with Gong.

Either way this runs through your Gong admin. The alternative is
reverse-engineering Gong's web app with your own browser session, as this project
did for Plaud. It's technically plausible, but it probably breaches Gong's terms
and your IT policy, so it's out of scope unless explicitly approved.

**If no credential is forthcoming, Phase 1 is the ceiling.** It's already one
command per batch of downloads. Tracked in [issue #2](https://github.com/rwxford/plaudport/issues/2).

### Security, when it's built

- The Gong key goes in `.env` (`GONG_ACCESS_KEY`, `GONG_ACCESS_KEY_SECRET`,
  `GONG_API_BASE`) and is never logged. The api host is added to
  `PLAUD_ALLOWED_HOSTS` explicitly, and it has to be.
- Media URLs are presigned credentials in their own right. They get the same
  treatment as Plaud's share audio links: used once, never printed.
- Read-only at the source: nothing is ever written back to Gong.
