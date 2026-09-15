# Plaud's upload flow

Recorded from a real import on **2026-09-15**. Unofficial and undocumented.

No values from the observed session appear here — endpoint shapes only.

## Authentication: `x-pld-user`

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
parts, so the part size is ~5 MB and the client decides nothing — the server
hands back exactly as many URLs as it wants parts.

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

`parts` carries the per-part identity (number + ETag) — exact shape **TBC**.

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

`filename`, `start_time` and `timezone` are ours to set, which means an imported
share can carry **its original title and recording date** rather than the date it
was uploaded.

## Still unknown

- The exact shape of `parts` in step 3.
- The values Plaud sends for `scene`, `is_tmp`, `support_mul_summ`, `file_type`,
  `serial_number` — constants, but they have to match.
- Whether `confirm_upload` accepts a transcript, or whether derived data needs a
  separate call. Nothing in the observed capture wrote a transcript, because a
  hand-import has none to write.

`npm run scan:upload -- <har> --show-body` fills the first two in: it prints API
request values with credential-shaped keys masked.

## What this does not answer

Whether a transcript can be **attached** to the created file. If it cannot, an
imported recording gets re-transcribed by Plaud and the original transcript stays
only in the local archive — which is why `fetch:share` saves it regardless.
