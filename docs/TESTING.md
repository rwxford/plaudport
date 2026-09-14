# How to check this actually works

Three levels, cheapest first. You can stop at whichever answers your question.

## Level 1 — does the code hold together? (5 seconds)

```bash
npm test
npm run typecheck
```

Unit tests for the fiddly logic: share-link parsing (including your real example
link, percent-encoding, truncated links, links pointing at the wrong site) and
the host allowlist. `typecheck` catches type mistakes across the whole project.

Both also run automatically on every push — the green check next to a commit on
GitHub means both passed there too.

## Level 2 — does the whole pipeline work on *my* Mac? (30 seconds)

```bash
npm run demo
```

This is the one to run. It stands up a fake share page on your own machine that
serves real audio and offers no download link — exactly the situation Plaud
puts you in — then runs the actual tools against it:

1. writes the kind of browser recording (HAR) you'd capture from Plaud
2. runs `scan:har` to find the audio inside it
3. runs `fetch:audio` to download it
4. checks the downloaded bytes are **identical** to what was served
5. checks the safety guards refuse bad input

Every step prints PASS or FAIL. At the end it points at a real `.wav` file —
`open` it and you should hear a two-second tone. That tone travelled the same
path a real meeting recording will: recorded → found → downloaded → verified.

No Plaud account, no login, no internet needed. If this passes, the machinery
works and the only remaining unknown is Plaud's real page.

If anything says FAIL, send me the whole output.

## Level 3 — does it work against a real Plaud share link?

This is the real test, and the only one that can still surprise us.

```bash
npm run probe:share -- "https://web.plaud.ai/s/pub_...::..."
```

Tells you what that link exposes. Safe to paste the output back to me — it
reports structure, never the meeting's content.

Then follow **`docs/GET-THE-AUDIO.md`** to capture a browser recording and pull
the audio out:

```bash
npm run scan:har   -- ~/Downloads/web.plaud.ai.har
npm run fetch:audio -- --from-scan
```

Success looks like: an audio file in `data/shares/` whose size roughly matches
the meeting's length, which plays when you open it.

Known ways this can legitimately fail, none of them mysterious:

| What you see | What it means | What to do |
|---|---|---|
| "No audio/media requests in this HAR" | The audio never played, so it was never fetched | Re-record, and press play this time |
| A `.m3u8` playlist instead of a file | Audio is streamed in segments | Tell me — needs ffmpeg support added |
| `HTTP 403` when downloading | The signed link expired (they last hours) | Re-record the HAR, scan again |
| "not in PLAUD_ALLOWED_HOSTS" | Audio is served from a CDN we haven't seen | The error prints the exact line to add it |

## What is *not* tested yet

**Uploading into Plaud.** No code has ever successfully written to a Plaud
workspace — not here, not in the migration project. Until that's proven, the
honest end of this pipeline is an audio file on your disk that you import by
hand through Plaud Web. Anything claiming otherwise would be guesswork.
