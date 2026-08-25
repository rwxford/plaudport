#!/usr/bin/env bash
# Fail if anything that looks like a secret or like personal Plaud data is
# tracked by git. Runs in CI and as an optional pre-commit hook:
#
#   npm run check:secrets
#   bash scripts/install-hooks.sh   # to run it before every commit
#
# This is a safety net, not a guarantee. The real rule is: secrets live in .env
# (gitignored) or the macOS Keychain, never in a file you `git add`.
set -uo pipefail

SELF="scripts/check-no-secrets.sh"
fail=0

note() { echo "  ✗ $1"; fail=1; }

# 1. Env files: only .env.example may be tracked.
while IFS= read -r f; do
  [ "$f" = ".env.example" ] && continue
  note "tracked env file: $f — move its values into .env (gitignored)"
done < <(git ls-files -- '.env' '.env.*' 2>/dev/null)

# 2. Media / database / report files that could only be your own Plaud data.
while IFS= read -r f; do
  note "tracked data file: $f — your recordings and ledger belong in ./data (gitignored)"
done < <(git ls-files -- '*.mp3' '*.m4a' '*.wav' '*.aac' '*.flac' '*.sqlite' '*.db' '*-report.json' 2>/dev/null)

# 3. Credential-shaped strings in tracked text.
#    Patterns are built at runtime so this script does not trip over itself.
b='[Bb]earer'
patterns=(
  "${b} [A-Za-z0-9._~+/-]{20,}"          # bearer token
  "eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"  # JWT
  "PLAUD_TOKEN=.+"                        # filled-in token
  "gh[pousr]_[A-Za-z0-9]{20,}"            # GitHub token
  "AKIA[0-9A-Z]{16}"                      # AWS access key id
  "sk-[A-Za-z0-9]{20,}"                   # generic API key
  "-----BEGIN [A-Z ]*PRIVATE KEY-----"    # private key
)

files=$(git ls-files | grep -vE "^($SELF|\.gitignore)$" || true)
for p in "${patterns[@]}"; do
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    note "possible secret at $hit"
  done < <(echo "$files" | tr '\n' '\0' | xargs -0 -r grep -InE "$p" 2>/dev/null | cut -d: -f1,2)
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "Secret/data check FAILED. Nothing above should be in a public repo."
  exit 1
fi

echo "Secret/data check passed — no tracked secrets or Plaud data."
