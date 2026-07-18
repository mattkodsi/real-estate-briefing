#!/bin/bash
# Install (or update) the Mac failover watchdog.
#
# macOS blocks launchd agents from reading ~/Desktop (TCC), so the watchdog
# runs from a self-contained copy in ~/Library/Application Support/briefing.
# Re-run this script after changing any scripts/*.py to refresh that copy.
#
# Remove everything:
#   launchctl bootout gui/$(id -u)/com.briefing.watchdog
#   rm -rf ~/Library/LaunchAgents/com.briefing.watchdog.plist "~/Library/Application Support/briefing"
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Library/Application Support/briefing"
PLIST="$HOME/Library/LaunchAgents/com.briefing.watchdog.plist"

mkdir -p "$APP/scripts" "$HOME/Library/Logs" "$HOME/Library/LaunchAgents"
cp "$REPO"/scripts/watchdog.py "$REPO"/scripts/fill_content.py \
   "$REPO"/scripts/fill_browser.py "$REPO"/scripts/fetch_article.py "$APP/scripts/"

# persistent Playwright venv beside the copies (Chromium itself lives in the
# shared ~/Library/Caches/ms-playwright and is reused)
if [ ! -x "$APP/.venv-fill/bin/python" ]; then
  python3 -m venv "$APP/.venv-fill"
  "$APP/.venv-fill/bin/pip" install -q playwright==1.49.1
fi
"$APP/.venv-fill/bin/playwright" install chromium >/dev/null 2>&1 || true

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.briefing.watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP/.venv-fill/bin/python</string>
    <string>$APP/scripts/watchdog.py</string>
  </array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/briefing-watchdog.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/briefing-watchdog.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/com.briefing.watchdog" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "watchdog installed: checks every 30 min; log at ~/Library/Logs/briefing-watchdog.log"
