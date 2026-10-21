#!/bin/bash
# Double-click in Finder. Keep this file beside package.json.
cd -- "$(dirname -- "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "PlaudPort needs Node.js 20 or newer. Install the LTS release from https://nodejs.org/"
  echo "Then open this file again. Press Return to close."
  read -r
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "PlaudPort needs Node.js 20 or newer. Update Node.js, then try again."
  echo "Press Return to close."
  read -r
  exit 1
fi
if [ ! -d node_modules/tsx ] || [ ! -d node_modules/zod ]; then
  echo "One-time setup is not complete. In Terminal, open this folder and run: npm install"
  echo "Then open this file again. Press Return to close."
  read -r
  exit 1
fi
printf '\nStarting PlaudPort. Your browser will open automatically.\n'
node --import tsx src/webServer.ts --open
status=$?
if [ "$status" -ne 0 ]; then
  echo "If PlaudPort is already running, use its existing browser tab or close the other Terminal window."
  echo "Press Return to close."
  read -r
fi
exit "$status"
