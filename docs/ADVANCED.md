# Advanced configuration and development

For importing shared recordings through the browser, see the [README](../README.md).

## Experimental Team migration research

For the migration spike (needs your own token):

```bash
cp .env.example .env       # then fill PLAUD_API_BASE + PLAUD_TOKEN
npm run hooks:install      # optional: pre-commit secret check
npm run spike              # read-only probes; writes data/spike-report.json
```

## Configuration
All settings come from the environment; `.env.example` is the template.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PLAUD_API_BASE` | yes | — | Origin + path prefix of the Plaud web API |
| `PLAUD_TOKEN` | yes | — | Bearer token from web.plaud.ai (**secret**) |
| `PLAUD_USER_TOKEN` | for upload | — | `x-pld-user` header from a signed-in session (**secret**) |
| `PLAUD_DEVICE_ID` | for upload | generated | `x-device-id` from that same session |
| `PLAUD_AUTH` | maybe | — | `Authorization` header, if Plaud sends one (**secret**) |
| `PLAUD_COOKIE` | maybe | — | `Cookie` header, if Plaud authenticates by cookie (**secret**) |
| `PLAUD_EXTRA_HEADERS` | no | — | JSON of extra headers, if your account needs them |
| `PLAUD_ALLOWED_HOSTS` | no | Plaud web/api/resource + both S3 buckets | SSRF guard for every outbound call |
| `PLAUD_DATA_DIR` | no | `./data` | Where backups, ledger, and reports are written (gitignored) |
| `PLAUD_REQUEST_TIMEOUT_MS` | no | `30000` | Per-request timeout |
| `PLAUD_REDACT_SAMPLES` | no | `true` | Strip string values out of report samples |
| `PLAUD_ALLOW_WRITE_TEST` | no | `false` | Unlocks the guarded M0 write test |

Later milestones add a few more (local UI bind/port, concurrency, backup
freshness); they're listed and commented out at the bottom of `.env.example`.

## Scripts
| Command | What it does |
|---|---|
| `npm run probe:share -- "<link>"` | Report what a public share link exposes |
| `npm run import -- "<link>" \| <links.txt> \| <call.mp4>` | **Archive + import.** Share links, a file of them, recordings on disk (e.g. Gong downloads), or a mix |
| `npm run web` | Local web page: paste a link, click Import, watch progress (loopback only) |
| `npm run import:audio -- --from-share <dir>` | Upload an already-archived recording (lower level) |
| `npm run fetch:share -- "<link>"` | Archive only, without uploading (lower level) |
| `npm run check:auth` | Check your upload credentials, and when they expire |
| `npm run chrome:install` | Set up automatic credential sync from Chrome (macOS; one-time extension setup) |
| `npm run test:chrome` | Test the Chrome extension and native helper without a Plaud account |
| `npm run set:auth` | Manual fallback: update the bearer token from the clipboard |
| `npm run fetch:audio -- --from-scan` | Download audio found by `scan:har` (fallback route) |
| `npm run scan:har -- <file.har>` | Derive the endpoint map from a DevTools HAR export |
| `npm run scan:upload -- <file.har>` | Work out how the web app uploads audio (for the import step) |
| `npm run scan:curl` | Describe a "Copy as cURL" request from the clipboard, values masked |
| `npm run demo` | End-to-end self-test with a fake share page — no Plaud needed |
| `npm test` | Unit tests |
| `npm run spike` | M0 read-only probes → `data/spike-report.json` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check:secrets` | Fails if secrets or Plaud data are tracked by git |
| `npm run hooks:install` | Installs the secret check as a pre-commit hook |

## Roadmap
- Share import: `PRD-SHARE-IMPORT.md` §9. Done through **S4** — fetch,
  archive, upload (verified live), and a local web UI (`npm run web`).
- Migration: `PRD.md` §9. The upload flow discovered here is the same one
  M0 needed, so that gate is now answerable.

Still open on both: attaching an original transcript to an uploaded recording.
No endpoint for it has been observed.

## Testing
`npm run demo` proves the whole pipeline on your own machine in 30 seconds,
without a Plaud account. See [Testing](TESTING.md) for all three levels.

## Contributing
See [Contributing](../CONTRIBUTING.md). Endpoint findings are the most useful contribution — as
paths and shapes, never as real ids or content.

## License
MIT — see [LICENSE](../LICENSE).
