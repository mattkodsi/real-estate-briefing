#!/usr/bin/env bash
# One-command rollout for the static app. Bumps the version in EVERY spot that
# needs it, sanity-checks the JS, then commits and pushes.
#
#   scripts/deploy.sh "what changed"
#
# Version lives in three files (no build step, so it's literal in each):
#   - js/app.js   APP_VERSION = "vNN"   (the Status page "This device" readout)
#   - index.html  ?v=NN on css/js/manifest/sw-register  (browser + CDN cache bust)
#   - sw.js       VERSION "vNN" + ?v=NN on the cached shell assets
# This script keeps all of them in lockstep so none can drift.
set -euo pipefail
cd "$(dirname "$0")/.."

msg="${1:-}"
if [ -z "$msg" ]; then
  echo "usage: scripts/deploy.sh \"commit message\""
  exit 1
fi

cur=$(grep -o 'const APP_VERSION = "v[0-9]*"' js/app.js | grep -o '[0-9]*')
if [ -z "$cur" ]; then echo "couldn't find APP_VERSION in js/app.js"; exit 1; fi
next=$((cur + 1))
echo "Bumping v$cur → v$next"

sed -i '' "s/const APP_VERSION = \"v$cur\"/const APP_VERSION = \"v$next\"/" js/app.js
sed -i '' "s/v=$cur/v=$next/g" index.html
sed -i '' "s/\"v$cur\"/\"v$next\"/g; s/v=$cur/v=$next/g" sw.js

# fail before pushing if either script won't parse
node --check js/app.js
node --check sw.js

git add -A
git commit -q -m "$msg (v$next)"
git push -q origin main
echo "Deployed v$next → https://briefing.pierrepontcompanies.com"
