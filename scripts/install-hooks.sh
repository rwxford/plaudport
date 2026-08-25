#!/usr/bin/env bash
# Install a pre-commit hook that runs the secret/data check before every commit.
# Optional but recommended, since this repo is public.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
hook="$root/.git/hooks/pre-commit"

cat > "$hook" <<'HOOK'
#!/usr/bin/env bash
exec bash "$(git rev-parse --show-toplevel)/scripts/check-no-secrets.sh"
HOOK

chmod +x "$hook"
echo "Installed pre-commit hook -> $hook"
