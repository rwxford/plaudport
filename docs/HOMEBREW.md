# Installing PlaudPort with Homebrew

Homebrew lets people install the command-line tool with one line and update it
with `brew upgrade` — no cloning, no folder to manage.

```bash
brew install rwxford/tap/plaudport
plaudport web          # open the local web page
```

`plaudport` subcommands mirror the `npm run` scripts: `import`, `web`,
`set-auth`, `check-auth`, `probe`, `fetch`, `import-audio`, `chrome-install`.
Run `plaudport help` for the list.

> The Homebrew install covers the terminal tool and the web UI. The Chrome
> credential helper still has one manual step (loading the unpacked extension);
> the formula's caveats print the exact folder. Only the Chrome Web Store removes
> that step — see `docs/CHROME-AUTH.md`.

---

## Publishing the tap (one-time, repo owner)

A Homebrew "tap" is just a second public GitHub repo of yours whose name starts
with `homebrew-`. `brew install rwxford/tap/plaudport` expands to
`github.com/rwxford/homebrew-tap`.

### 1. Create the tap repo
Create a public repo named exactly **`homebrew-tap`** under your account. Its
whole contents will be:

```
homebrew-tap/
└── Formula/
    └── plaudport.rb
```

### 2. Cut a release of plaudport
From a checkout of `plaudport`, on an up-to-date `main`:

```bash
scripts/release.sh            # tags the version in package.json, prints url + sha256
# or: scripts/release.sh 0.2.0   to set a new version first (commit via PR, then re-run)
```

It tags `vX.Y.Z`, pushes the tag, and prints the three values the formula needs.

### 3. Fill in and commit the formula
Copy `packaging/homebrew/plaudport.rb` from this repo into the tap at
`Formula/plaudport.rb`, replacing `version`, `url`, and `sha256` with what the
release script printed. Commit and push to `homebrew-tap`.

That's it — `brew install rwxford/tap/plaudport` now works for anyone.

### 4. Shipping an update later
```bash
scripts/release.sh 0.2.0      # bump + tag + print new url/sha256
```
Update the same three lines in the tap's `plaudport.rb` and commit. Users get it
with `brew update && brew upgrade plaudport`. (`brew bump-formula-pr` can
automate the bump if you prefer.)

## Notes

- **Node** is pulled in automatically (`depends_on "node"`).
- The formula runs `npm ci` during install to fetch the exact dependencies for
  the user's Mac — `tsx`/`esbuild` have per-architecture native binaries, so a
  prebuilt `node_modules` can't be shipped cross-platform. A personal tap is
  allowed network access at install time, so this is fine.
- `brew uninstall plaudport` removes the program. Your imported recordings and
  `.env` live in whatever folder you ran it from and are left untouched; the
  Chrome helper is removed with `plaudport chrome-install --uninstall`.
