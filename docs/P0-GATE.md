# P0 exit gate — results

Milestone P0 of [`PRD-PIPELINE.md`](PRD-PIPELINE.md) §9; checklist from
[`P0-PLAN.md`](P0-PLAN.md) §9. Evidence classes per `CLAUDE.md` §3a:
**(a)** automated, **(b)** live-account, **(c)** calibration. Counts only —
never recording ids, titles or transcript text. A check not yet run is
**pending**, with who runs it; a simulated check never stands in for a live one.

**Status: automated checks pass; every live-account check is pending (owner).**

| # | Check | Class | Status | Evidence |
|---|---|---|---|---|
| G1 | `pull --all --dry-run` lists the whole library; total = Plaud web count | b | **pending** — owner, after `doctor --install-mcp` + `login` | listed: — · web: — · pages: — · 429s: — |
| G1a | Same via the local `@plaud-ai/mcp` process confirms filtered paging (F2) | b | **pending** — owner, same run as G1 | pages: — · distinct ids = listed? — |
| G1c | Real `pull --all`; `audio_ok` count = listed (minus audio-less); `report --verify-audio 20` all match | b (+a) | **(a) pass** on the fake (`pull.test.ts`, demo step 7) · **(b) pending** — owner | audio_ok: — / listed: — · sample: —/— |
| G2 | Dense day (≥ 10): `pull --since D --until D --dry-run` = web count for D | b | **pending** — owner picks D | listed: — · web: — |
| G3 | Expired URL. (a) `PLAUDPORT_DEBUG_URL_AGE_HOURS=25` → refresh, attempts 0; (b) a real URL kept past 24 h → storage refuses it (403) → a refreshed URL downloads the archived bytes | a + b | **(a) pass** (`pull.test.ts`: forced age and a real 403 from the fake; the helper itself: `gate/g3b.test.ts`) · **(b) pending** — owner: `plaudport gate g3b start` after the first pull, `plaudport gate g3b finish` ≥ 24 h later | (b): paste the `finish` output — refused (HTTP —), refreshed download yes/no, sha256 matches yes/no |
| G4 | Transcript-less recording lands `plaud_text_pending`, later resolves | b | **(a) pass** on the fake · **(b) pending** — owner, two runs ≥ 10 min apart | before: — · after: — |
| G5 | Late-synced recording (device offline a day) discovered by the overlap window | b | **(a) pass** on the fake · **(b) pending** — owner, needs one day | created − start: — h (from `report --lag`) |
| G6 | `pull --reconcile` reports 0 defects after G1 | b | **(a) pass** on the fake · **(b) pending** — owner | defects: — |
| G7 | `index rebuild` reproduces the derived tables (`recordings`, `recording_artifacts`, `sync_lag_samples`) | a + b | **(a) pass** (`ledger.test.ts`, demo step 7) · **(b) pending** — owner, after G1c | dump diff: — |
| G8 | Every automated test (T2–T11) green in CI | a | pass locally (`npm test`, `npm run demo`); CI: see the PR | — |

## Also to record during the live run

- **R2 — refresh-token lifetime.** `plaudport doctor` prints the refresh
  token's expiry date after `login`; record it here, and the date of the
  first `AuthError` (exit 4) if one happens.
- **Audio host.** If the first live pull logs `audio host … is not in
  PLAUD_ALLOWED_HOSTS`, the presigned audio URLs come from a storage host the
  default allowlist does not name. Record the hostname here and add it to the
  default in `src/config.ts` + `.env.example` (a PRD §4 fact).
- **Rate limits (R3).** `report` prints requests and 429s for the last run.

## Pending by design (class c)

Overlap window (14 d) and text timeout (7 d) calibration: measurement
installed (`report --lag`); decision at 30 days of samples or P6, whichever is
first. Restore verification (FR14d) is P5.
