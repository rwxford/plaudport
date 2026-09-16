# Plaud's upload flow

Recorded from a real import on **2026-09-15**. Unofficial and undocumented.

No values from the observed session appear here — endpoint shapes only.

## Authentication: `Authorization: Bearer`, plus `x-pld-user`

**Corrected 2026-09-15.** This document first claimed `x-pld-user` was the
credential, because the HAR it was derived from showed no `Authorization` or
`Cookie` header on any request. That was an artifact of the export: Chrome's
**"Export HAR (sanitized)" strips both**. Checking the same request live in
DevTools shows an `Authorization: Bearer …` header *and* a session cookie.

`x-pld-user` accompanies the requests that touch the owner's data, but it does
not authenticate them on its own — sending it alone returns
`401 {"detail":"Not authenticated"}`, FastAPI's message for a security
dependency (`HTTPBearer`) finding nothing it recognises.

### The bearer expires in about a day

Observed: a token copied one afternoon was rejected ~24 hours later with
`status -419: workspace token expired`. It is a JWT, so its `exp` claim can be
read locally without any network call — `npm run check:auth` prints the expiry,
and `import:audio` refuses before uploading rather than after.

Re-copying it by hand is the current answer. Plaud's web app must refresh it
somehow; that flow has not been captured, and finding it means recording a
session across an expiry boundary.

**Lesson for the next capture:** always export with *"with sensitive data"*, and
treat a capture with no auth headers as suspect rather than informative.
`scan:upload` now says so when it sees one.

### The other headers

The write endpoints are authenticated by an **`x-pld-user`** header, not an
`Authorization: Bearer`. It appears on exactly the requests that touch the
owner's data (`get_upload_presigned_url`, the S3 PUTs, `merge_multipart`,
`confirm_upload`, `ai/label`) and is absent from the ones that don't
(`user/language`, `share/*/get`, `team-app/workspaces/can-create`).

Treat it as a full-access credential: it belongs in `.env` or the macOS Keychain,
never in the repo, never in a paste.

The same `x-device-id` / `x-request-id` client-invented headers ride along, as
with the share API.

## The sequence

An import is **four** real requests. Everything else in a capture is Sentry
telemetry (`guardian-web.plaud.ai`) and CORS preflights.

### 1. Ask where to put it

```
POST https://api.plaud.ai/file/get_upload_presigned_url
{ filesize, file_type }

-> { status: 0, message, data: { part_urls: [url, ...], upload_id, object_name } }
```

`part_urls` is one presigned S3 URL per part. A 9.3 MB file produced **two**
parts: the part size is **5 MiB (5,242,880 bytes)**, and the server hands back
exactly as many URLs as it wants parts.

**The file must be split on 5 MiB boundaries — not into equal chunks.** S3
requires every part except the last to be at least 5 MiB, so splitting 9.3 MB
into two equal 4.6 MB halves produces parts S3 will not reassemble. Plaud
surfaces that as `merge_multipart` returning `status 500: internal error`, which
says nothing about the real cause.

### 2. Send the bytes

```
PUT <part_url>        (plaud-bucket.s3-accelerate.amazonaws.com)
<raw bytes of that part>
```

Query carries the AWS signature plus `partNumber` and `uploadId`. Note the host:
**s3-accelerate**, different from the `s3.us-west-2` host that *serves* share
audio.

Each PUT returns an **ETag** header, which step 3 needs.

### 3. Reassemble

```
POST https://api.plaud.ai/file/merge_multipart
{ upload_id, object_name, parts }

-> { status: 0, data: { object_name, upload_id } }
```

```
parts: [ { Etag: "<md5 hex, quotes stripped>", PartNumber: 1 }, ... ]
```

Note the capitalisation: `Etag` and `PartNumber`, not `ETag`/`part_number`.
The ETag comes from each PUT's response header.

### 4. Create the file record

```
POST https://api.plaud.ai/file/confirm_upload
{ upload_id, object_name, scene, is_tmp, support_mul_summ,
  file_type, filename, start_time, session_id, serial_number, timezone }

-> { status: 0, data: { id, workspace_id, owner_member_id, filename, filesize,
                        file_md5, fullname, location, version, ... } }
```

This is the one that makes the recording exist. `data.id` is the new file id —
the handle for verifying the import afterwards through the official Plaud MCP.

**Mind the prefix.** `confirm_upload` returns a bare id like
`e3732bd1…`, but Plaud's file ids carry an `of_` prefix everywhere else,
including the MCP — where the bare form returns 404. Same id, two spellings.

`filename`, `start_time` and `timezone` are ours to set, which means an imported
share can carry **its original title and recording date** rather than the date it
was uploaded.

### The confirm_upload constants

| Field | Value | Note |
|---|---|---|
| `scene` | `101` | web import |
| `is_tmp` | `0` | |
| `support_mul_summ` | `true` | |
| `file_type` | `"MP3"` | uppercase |
| `filename` | title **without** extension | the web app sent `"audio"` for `audio.mp3` |
| `start_time` | epoch ms | ours to choose — use the original recording time |
| `timezone` | **number**, e.g. `-4` | a UTC offset, *not* the IANA string the share API's header wants |
| `session_id` | **integer**, `0` for a web import | NOT the UUID-shaped `session_id` that `/file/welcome` returns — same name, different thing. Sending a UUID gets `422 int_parsing`. |
| `serial_number` | a UUID **string** | 36 chars; nothing ties it to hardware |

The two are easy to mix up, and a capture makes it worse: a redacting scanner
shows a masked string with its length (`<masked:36>`) but a masked number without
one (`<masked>`). That distinction is the only hint in the capture that
`session_id` is numeric.

## Capturing your `x-pld-user`

1. Sign in at web.plaud.ai, open DevTools → **Network**, click around until an
   `api.plaud.ai` request appears.
2. Click it → **Headers** → **Request Headers** → copy the `x-pld-user` value.
3. Put it in `.env` as `PLAUD_USER_TOKEN=...`. `.env` is gitignored, and the
   secret check refuses to commit it.

Treat it like your password: it is full access to your account, it does not
expire quickly, and it belongs in no paste, screenshot or issue.

## Still unknown

Whether a transcript can be **attached** to the created file. Nothing in the
observed capture wrote one, because a hand-import has no transcript to write.
Finding out means capturing an edit of a transcript in the web app.

Confirmed by importing for real: an uploaded file has **no transcript** until the
owner asks Plaud to produce one. Transcription is not automatic on import.

If it cannot be attached, an imported recording gets re-transcribed by Plaud and
the original transcript stays only in the local archive — which is why
`fetch:share` saves it regardless.
