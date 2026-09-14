# Getting the audio out of a Plaud share link (fallback route)

> **You probably don't need this any more.** Plaud's share API turned out to be
> unauthenticated, so `npm run fetch:share -- "<link>"` does all of this in one
> command — see the README. Keep this page for the day Plaud changes that API and
> we need to re-discover it, or when a share behaves unusually.

A Plaud share page plays the recording but gives you no download button. The
browser still has to fetch that audio over the network, so we record what it
fetched and download the same thing.

Five minutes, once. You need Chrome and the repo checked out.

## Step 1 — record the page fetching its audio

1. Open the share link in Chrome. **Use a private window** (⇧⌘N) — it keeps your
   own Plaud login out of the recording, so nothing sensitive of yours ends up in
   the file you're about to save.
2. Press **⌥⌘I** to open DevTools, click the **Network** tab.
3. Tick **Preserve log**.
4. Reload the page (⌘R), then **press play on the audio** and let it run for a few
   seconds. This is the step people skip — if you never press play, the audio is
   never fetched, and there's nothing to find.
5. Right-click anywhere in the request list → **Save all as HAR with content**.
   Save it to Downloads.

## Step 2 — find the audio in that recording

```bash
cd plaudport
npm run scan:har -- ~/Downloads/web.plaud.ai.har
```

(If the file has a different name, drag it from Finder onto the Terminal window
instead of typing the path.)

Look for the **Audio / media requests** section. One of three things happens:

- **A single audio file** (`audio/mpeg`, some number of MB) → go to step 3.
- **A streaming playlist** (`.m3u8`) → the audio comes in segments and needs
  stitching with ffmpeg. Say so and that gets built; don't fight it by hand.
- **Nothing** → you didn't press play, or the page streams in a way we haven't
  seen. Re-record, and if it's still empty, send me the scan output.

## Step 3 — download it

```bash
npm run fetch:audio -- --from-scan
```

That grabs the largest audio file the scan found and saves it under
`data/shares/`, alongside a small `.json` noting its size and SHA-256 so you can
prove later it's the same file.

If it refuses because the host isn't allowlisted, it prints the exact line to
fix it — Plaud serves media from a CDN, and that hostname belongs in
`PLAUD_ALLOWED_HOSTS` once you've seen it's legitimate.

Name the output if you like:

```bash
npm run fetch:audio -- --from-scan --out "2026-09-12 board sync.mp3"
```

## Step 4 — what to do with the file

Right now: **import it into Plaud by hand** — Plaud Web → your Personal
workspace → import audio. That's the end-to-end result you asked for, available
today, without waiting on the automated path.

Later: the same file is what the automated importer will upload, once we've
confirmed Plaud's web API accepts an upload at all.

## Two things worth knowing

**Signed links expire.** The media URL in a HAR usually carries a signature good
for hours. If `fetch:audio` returns 403, the link went stale — re-record the HAR
and scan it again. Nothing is broken.

**The HAR and the scan are sensitive.** The HAR contains the share's access
token, and `data/har-scan.json` keeps full media URLs including their signatures
— that's deliberate, since `--from-scan` needs them. Both stay on your machine:
`*.har` and `data/` are gitignored, and the secret check refuses to commit them.
What the scan prints to your screen has query strings stripped, so the terminal
output is safe to paste to me. Delete the `.har` from Downloads when you're done.
