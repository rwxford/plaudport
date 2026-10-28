#!/usr/bin/env bash
# Cut a release and print the Homebrew formula values.
#
#   scripts/release.sh            # use the version in package.json
#   scripts/release.sh 0.2.0      # set that version first
#
# It tags vX.Y.Z, pushes the tag, then downloads the GitHub source tarball and
# prints its URL + sha256 so you can paste them into the tap's plaudport.rb.
set -euo pipefail

cd "$(dirname "$0")/.."
owner_repo="rwxford/plaudport"

version="${1:-$(node -p "require('./package.json').version")}"
if [ "${1:-}" ]; then
  # Bump package.json to the requested version and commit it first.
  node -e "const f='package.json',p=require('./'+f);p.version='$version';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
  git add package.json
  git commit -m "Release v$version" || true
  echo "Bumped package.json to $version — push this commit (via a PR) before the tag is meaningful."
fi

tag="v$version"
echo "Tagging $tag…"
git tag -a "$tag" -m "$tag"
git push origin "$tag"

url="https://github.com/$owner_repo/archive/refs/tags/$tag.tar.gz"
echo "Fetching $url to compute its checksum…"
sha="$(curl -fsSL "$url" | shasum -a 256 | cut -d' ' -f1)"

cat <<EOF

Done. In your tap repo (rwxford/homebrew-tap), set Formula/plaudport.rb to:

  version "$version"
  url "$url"
  sha256 "$sha"

Then commit. Users update with:  brew update && brew upgrade plaudport
EOF
