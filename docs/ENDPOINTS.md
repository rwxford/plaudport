# Capturing the Plaud web API (M0 prerequisite)

The Plaud web API is unofficial and undocumented. Before the spike can do anything,
capture the base URL, your token, and a few request shapes from your own session.

## 1. Get a bearer token + base URL
1. Sign in at https://web.plaud.ai (if you use Google SSO, first set a password via
   "Forgot Password").
2. Open Chrome DevTools → **Network** tab → filter **Fetch/XHR**.
3. Click around: open the recordings list, open one recording's transcript.
4. Pick any XHR request to the API host. Record:
   - **Base URL** (e.g. the `https://...` origin + path prefix) → `PLAUD_API_BASE`
   - **Authorization** header value (`Bearer ...`) → `PLAUD_TOKEN`
5. Paste both into `.env`.

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
- Record everything in `spike-report.json`. If import or derived-write is impossible,
  **STOP** and reassess (decision O1).
