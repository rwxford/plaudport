# Capturing the Plaud web API (M0 prerequisite)

The Plaud web API is unofficial and undocumented. Before the spike can do anything,
capture the base URL, your token, and a few request shapes from your own session.

> **Everything you capture here is account-specific.** The token is a full-access
> credential, and saved HAR files and DevTools screenshots contain it. Keep all of
> it out of git: token → `.env`, findings → paths and shapes only. See `SECURITY.md`.

## 1. Get a bearer token + base URL
1. Sign in at https://web.plaud.ai (if you use Google SSO, first set a password via
   "Forgot Password").
2. Open Chrome DevTools → **Network** tab → filter **Fetch/XHR**.
3. Click around: open the recordings list, open one recording's transcript.
4. Pick any XHR request to the API host. Record:
   - **Base URL** (e.g. the `https://...` origin + path prefix) → `PLAUD_API_BASE`
   - **Authorization** header value (`Bearer ...`) → `PLAUD_TOKEN`
5. Paste both into `.env`.

## 1b. Easier: let the HAR scanner map it for you

Instead of transcribing paths by hand:

1. In DevTools → **Network**, tick **Preserve log**, then use the Plaud web app
   normally: open the recordings list, open a recording, open its transcript and
   summary, switch to the Team workspace, and (if you can) import one audio file.
   The scanner can only find endpoints you actually exercised.
2. Right-click anywhere in the request list → **Save all as HAR with content**.
3. Run it through the scanner (no token needed for this step):

```bash
npm run scan:har -- ~/Downloads/web.plaud.ai.har
```

It prints every API call it found as a path template, plus a suggested block to
paste into `src/config.ts`. Verify each guess against the list — they are keyword
matches, not certainties.

The scanner never copies your token, header values, or response content into its
output; it keeps methods, paths, parameter names, status codes and redacted
shapes. **Delete the `.har` afterwards** — that file does contain your token.
`*.har` is gitignored so it can't be committed by accident.

## 2. Map these endpoints (fill in as you discover them)
> The spike reads these from `src/config.ts`. Update paths to match what you see.

| Purpose | Method | Path (fill in) | Notes |
|---|---|---|---|
| Current user / profile | GET | `/me` ? | confirms token works |
| List workspaces | GET | ? | need Personal + Team IDs |
| List recordings (per workspace) | GET | ? | pagination params? |
| Get recording detail | GET | ? | duration, size, ids |
| Get transcript | GET | ? | |
| Get summary / notes / action items | GET | ? | |
| Download audio | GET | ? | may be a signed URL |
| **Import audio into workspace** | POST | ? | **M0 write test** |
| **Write transcript/summary/note** | POST/PUT | ? | **M0 write test** — may not exist |
| Trigger regenerate transcript/summary | POST | ? | optional |

## 3. Header/auth notes
- Some deployments require extra headers (e.g. a workspace/tenant id). Capture any
  custom `x-*` headers and add them in `src/plaudClient.ts` (`extraHeaders`).
- Token lifetime is ~300 days; refresh flow (email+password) is out of scope for M0.

## 4. M0 exit criteria
- Read probes succeed for both workspaces.
- Import test: one throwaway audio imports into Team (private) — or is proven impossible.
- Derived-write test: transcript/summary can be written/attached — or is proven impossible.
- Record everything in `data/spike-report.json` (gitignored; samples are redacted
  unless you set `PLAUD_REDACT_SAMPLES=false`). If import or derived-write is
  impossible, **STOP** and reassess (decision O1).
