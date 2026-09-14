# Plaud's public share API

Recorded from a real share page on **2026-09-14**. Unofficial and undocumented:
Plaud can change it without notice. All of it is isolated in `src/shareClient.ts`
so a change is a one-file fix.

No content from the observed recording appears here — field names and shapes only.

## Authentication: none

A share link is its own authorisation. There is no bearer token, no cookie, no
login. The `<id>::<token>` pair in the URL is the credential — **treat a share
link like a password for that one recording**.

The web app sends `x-device-id` (a client-generated hex string) and
`x-request-id` on each call. Nothing is authenticated by them; we send plausible
values for consistency with the app.

## Endpoints

Base: `https://api.plaud.ai` (override with `PLAUD_SHARE_API_BASE`)

### `GET /share/access/<pub_id>::<token>`

Everything except the audio bytes.

```
{
  status: 0,              // 0 = OK. Non-zero is an error even with HTTP 200.
  object_type: string,
  owner_name: string,     // may be empty
  is_audio: 0 | 1,        // whether audio exists for this share
  is_trans: 0 | 1,        // whether a transcript exists
  is_ai_content: 0 | 1,
  is_mindmap: 0 | 1,
  data_file: {
    id: string,                  // 32-char hex
    filename: string,            // the recording's title
    is_trash: boolean,
    start_time: number,          // epoch milliseconds
    duration: number,            // milliseconds
    file_language: string,       // e.g. "en"
    trans_result: [              // the original transcript
      { content, speaker, original_speaker, start_time, end_time, embeddingKey }
    ],
    transaction_polish: [        // AI-cleaned transcript, same shape
      { content, speaker, start_time, end_time }
    ],
    outline_result: [ { topic, start_time, end_time } ],
    notes_list: [                // summaries / AI notes, one per tab in the UI
      { data_id, data_type, data_title, data_tab_name, data_content, data_link, data_error_code }
    ],
    download_link_map: {}        // empty in the observed response
  }
}
```

Utterance `start_time` / `end_time` are millisecond offsets from the start of
the recording.

### `GET /share/access/<pub_id>::<token>/audio`

```
{ status: 0, temp_url: string }
```

`temp_url` is a presigned S3 link (observed: ~1.7 KB long, pointing at
`plaud-bucket.s3.us-west-2.amazonaws.com/audiofiles/<hash>.mp3`). It **expires** —
fetch it immediately before downloading, never cache it.

The bucket responds to range requests; the browser fetches with `Range` and gets
`206 Partial Content`, and the content type is `binary/octet-stream` rather than
`audio/mpeg`, so a naive "is this audio?" check on content type would reject it.

### Other observed hosts

| Host | Role |
|---|---|
| `api.plaud.ai` | the share API above |
| `plaud-bucket.s3.us-west-2.amazonaws.com` | audio bytes, presigned |
| `resource.plaud.ai` | thumbnails referenced by `og:image` |
| `web-static.plaud.ai` | the web app's own assets |

The first three are in the default `PLAUD_ALLOWED_HOSTS`.

## Behaviour worth knowing

**The share page serves two different documents.** Request it without a browser
`User-Agent` and you get a ~1.5 KB link-preview stub: meta tags only, no scripts,
no data. With a browser UA you get ~2.2 KB — still a shell, since the content is
fetched by JavaScript from the API above. Neither contains the transcript, so
scraping the HTML was never going to work.

**Meta tags leak the title.** `og:title`, `og:description` and `og:image` are
present in the stub, which is how link previews in Slack show a meeting's title.

**`status` is the real error channel.** HTTP 200 with `status != 0` means the
request failed — usually a revoked or malformed link. `src/shareClient.ts` treats
a non-zero `status` as an error.

## What this does *not* cover

Writing anything **into** a Plaud workspace. No upload endpoint has been observed
or tested; that remains the open question for both this feature and the
Personal→Team migration (`docs/PRD.md` M0).
