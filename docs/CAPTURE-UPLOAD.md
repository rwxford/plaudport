# Capturing how Plaud imports audio

The one thing still unproven: whether we can upload audio into a Plaud workspace
the way the web app does. To find out, we watch the web app do it once.

This is the same browser-recording trick as `GET-THE-AUDIO.md`, with one
important difference: **you'll be logged in**, so the recording contains your own
Plaud credentials. Details on keeping that safe at the bottom.

## What you need

An audio file to import. Use the one you already have:

```
data/shares/<share-folder>/audio.mp3
```

Importing it is a real import — you wanted that meeting in your Personal
workspace anyway, so this step is useful work, not just a test.

## Capture it

1. Open **https://web.plaud.ai** and sign in. Make sure you're in your
   **Personal** workspace.
2. **⌥⌘I** → **Network** tab → tick **Preserve log**.
3. Start the import: however you normally do it — the import/upload button, or
   dragging the mp3 in. Let it finish completely, including any processing
   spinner, so the whole handshake is recorded.
4. Network toolbar → **⬇ Export HAR (with sensitive data)** → save to Downloads.
   Give it a name you'll recognise, like `import.har`.

   **If the ⬇ button gives you no menu**, your Chrome exports the sanitized
   form, which strips `Authorization` and `Cookie` — and a capture missing those
   will send you hunting for an auth mechanism that was simply redacted. Enable
   the full export first: DevTools **⚙ (gear)** → **Preferences** → **Network** →
   tick **"Allow to generate HAR with sensitive data"**.

   Or skip HAR for a single request: right-click it → **Copy** → **Copy as cURL**,
   then `npm run scan:curl`. That reads the clipboard and prints the endpoint,
   header names and body fields with every value masked — safe to share, unlike
   the cURL command itself.
5. Run:

```bash
npm run scan:upload -- ~/Downloads/import.har
```

(or type `npm run scan:upload -- ` and drag the file into Terminal)

## If I've asked for request values

```bash
npm run scan:upload -- ~/Downloads/import.har --show-body
```

adds the API request bodies, with anything credential-shaped masked
(`token`, `auth`, `secret`, `signature`, `session_id`, `serial`, `*_key`).
S3 and telemetry requests never have their bodies printed at all. Skim it before
pasting, as you would any output.

## What to send back

Paste the terminal output. It prints the write requests **in order**, with each
one's method, path, what kind of body it carried, and the field names or JSON
keys in it — but **no header values, no body contents, and no token**. That's
what I need to replicate the flow.

An import is usually three or four steps — ask the API where to put the file,
send the bytes, tell the API it's done — so the *sequence* matters more than any
single request.

## Keeping your token safe

- The `.har` file itself **does** contain your Plaud bearer token, which is
  full access to your account for months. Keep it on your machine and **delete it
  when we're done**. `*.har` is gitignored so it can't be committed.
- The scanner's output is safe to share; it reports names and shapes only.
- If you'd rather not create such a file at all, say so — the alternative is that
  I write the upload code against a best guess and we debug it against real
  errors, which is slower but never records your credentials.

## If the import fails or looks odd

Export the HAR anyway and run the scan. A failed attempt still shows which
endpoint was called and what it rejected, which is often more informative than a
clean success.
