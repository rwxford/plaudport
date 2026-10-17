# Automatic Plaud credentials from Chrome

For macOS, Google Chrome, Node.js 20 or newer. No daily DevTools, clipboard or
copy/paste. This uses a small unpacked Chrome extension and a native messaging
helper; it needs no npm dependencies beyond the existing project.

## One-time setup

Keep the checkout at a permanent path on your Mac (not a temporary download).
From that checkout:

```bash
npm install
npm run chrome:install
```

The installer registers the helper for **Google Chrome** under your own macOS
account, using a self-contained copy of the helper in Application Support and
your current Node executable. It does
not launch Chrome or read any credentials.

1. Open `chrome://extensions` in the Chrome **profile you use for Plaud**.
2. Enable **Developer mode**, choose **Load unpacked**, then select this
   checkout's `chrome-extension` directory (the installer prints its full path).
3. Pin **PlaudPort credential sync** using Chrome's Extensions menu so you can
   see its status.
4. Open [Plaud](https://web.plaud.ai/), sign in if needed, choose your
   **Personal** workspace, and reload. The badge turns green **OK** after a
   complete, non-expired credential set has been saved to `~/Library/Application Support/PlaudPort/chrome-auth.env` with owner-only
   permissions. Hover over the icon for
   the last-sync time. Clicking the icon shows a status popup with header presence (never token values)
   and an Open Plaud link.
5. Run `npm run check:auth` from the same checkout. The badge confirms a local
   save; this command confirms that Plaud accepts the credentials.

The extension ID is fixed by the public key in its manifest. You do not need to
copy an extension ID or token. The credential store is shared by local checkouts on your macOS account.
Running the installer again updates the copied helper runtime; rerun it after
updating the helper code. The extension source still lives in the checkout.

## Everyday use

Use the existing `npm run import -- ...` command. While you use Plaud in Chrome,
the extension observes authenticated file requests and writes updated
`PLAUD_AUTH`, `PLAUD_USER_TOKEN` and `PLAUD_DEVICE_ID` to the private credential
store together. PlaudPort loads them automatically alongside your local `.env`. Other
settings are preserved; you do not need to edit them. No upload or other Plaud
write is triggered by the extension or helper.

If Chrome has been idle for a day, open or reload Plaud before importing.
Sign back in if Plaud asks. The extension **captures a current session**; it
cannot renew a signed-out session or run while Chrome is closed. There is no
unattended Google/Apple login, scheduled refresh, or background page reload.

Load it in only the intended Chrome profile. The last complete observed session
wins, so keep Plaud on your intended **Personal** workspace. Do not load it in
profiles for other Plaud accounts. Switching accounts or workspaces may replace
the credentials used by your next import. Already-running commands keep the
credentials they loaded when they started: restart them after a refresh.
Current Chrome credentials override the same three keys in `.env`. Explicit
shell environment variables take precedence over both files; unset old
exported `PLAUD_AUTH`, `PLAUD_USER_TOKEN`, and `PLAUD_DEVICE_ID` values if needed.

## Updating an older installation that exits inside Chrome

If the popup says `HOST_EXITED`, rerun `npm run chrome:install` with this version,
then reload Plaud. Older installers launched scripts from the checkout under
Documents, where macOS may block Chrome's child process. The new installer copies
the entire helper and keeps credentials in Application Support. It does not
require Chrome access to your Documents folder or changes to macOS protections.

## Troubleshooting

- **No badge:** click the extension icon for diagnostics, then reload a signed-in Personal workspace. A request must contain
  all three headers. Public share pages and login requests do not qualify. The
  extension supports the observed `api.plaud.ai/file/` API; a Plaud API change
  may require updating it.
- **Orange `!`:** run `npm run chrome:install` from the intended checkout, then
  reload Plaud. Check that Node still exists at the path used for installation
  (rerun the installer after a Node upgrade or moving the checkout). Chrome's
  extension Errors panel may report a missing or disallowed native host.
- **Still `!`:** make sure the Application Support credential store is a regular file owned by
  you, not a symlink or hard link, and its parent directory is writable. The helper rejects expired tokens,
  tokens expiring within one minute, malformed values and concurrent writes.
  Sign back in and reload Plaud to capture a new session. A crash may leave
  `~/Library/Application Support/PlaudPort/chrome-auth.env.chrome-lock`; after all sync helpers have stopped, remove that empty
  lock and reload. No credentials are stored in the lock.
- **Green `OK`, but imports fail:** run `npm run check:auth`. This checks Plaud's
  acceptance, not just a token's timestamp. Confirm the intended account and
  workspace, then sign out/in and reload if needed. The extension does not
  capture cookies, so cookie-only authentication is not supported.
- **Extension disabled by your organization:** Chrome may prohibit unpacked
  extensions or native messaging. Use the existing `npm run set:auth` fallback
  until your administrator allows the extension.

Verified live on macOS with Chrome on 2026-10-17: credentials captured and
saved automatically, `npm run check:auth` accepted by Plaud, and a share-link
import completed successfully. Automated tests cover the protocol, installer,
capture filters, credential writes, and credential-loading precedence.

## Removal

Remove the extension at `chrome://extensions`, then from the registered checkout:

```bash
npm run chrome:install -- --uninstall
```

This removes its native host registration and copied helper runtime. It preserves
the saved credential store, `.env`, and all recordings. A launcher belonging to a different checkout is not
unregistered. To revoke the saved session too, sign out of Plaud and remove the
`~/Library/Application Support/PlaudPort/chrome-auth.env` file, plus any manual
credential copies in `.env`.

## Implementation references

- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome webRequest API](https://developer.chrome.com/docs/extensions/reference/api/webRequest)

The helper uses Chrome's length-prefixed JSON protocol over stdin/stdout. There
is no HTTP server, remote service, Chrome profile database access, or decryption
of Chrome credentials. See `SECURITY.md` for the full handling model.
