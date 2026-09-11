#!/usr/bin/env bash
# Release app assets from main, then verify the bytes served by GitHub Pages.
set -euo pipefail
cd "$(dirname "$0")/.."
msg="${1:-}"
if [ -z "$msg" ]; then echo 'usage: scripts/deploy.sh "what changed"'; exit 1; fi
if [ "$(git branch --show-current)" != main ]; then echo 'Merge the tested branch into main before deploying.'; exit 1; fi
# Never silently sweep unrelated files or credentials into a release.
if [ -n "$(git diff --cached --name-only)" ]; then echo 'Commit or unstage existing staged changes before deploying.'; exit 1; fi
npm run check
npm test
next=$(python3 - <<'PY'
import pathlib,re
p=pathlib.Path('js/app.js');s=p.read_text();cur=int(re.search(r'const APP_VERSION = "v(\d+)"',s)[1]);n=cur+1
p.write_text(s.replace(f'const APP_VERSION = "v{cur}"',f'const APP_VERSION = "v{n}"'))
for name in ['index.html','sw.js']:
 p=pathlib.Path(name);s=p.read_text().replace(f'v={cur}',f'v={n}').replace(f'"v{cur}"',f'"v{n}"');p.write_text(s)
print(n)
PY
)
git add -- index.html sw.js js/*.js css/*.css manifest.webmanifest icon.svg
git commit -m "$msg (v$next)"
git push origin main
python3 scripts/verify_release.py "$next"
