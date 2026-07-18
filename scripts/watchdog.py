#!/usr/bin/env python3
"""Failover watchdog — runs on the owner's Mac via launchd every 30 minutes.

The content-filling chain, in order:
  1. GitHub Actions browser heartbeat (primary, every 30 min) — writes a pulse
     (the `fill_heartbeat` row in Supabase) on every run, even no-ops.
  2. The cloud routine's own HTTP fill at each window (works only if its
     sandbox egress returns).
  3. THIS script: while the pulse is fresh it does NOTHING (exit in <1s).
     When the pulse goes stale (primary dead) it takes over — runs the HTTP
     fill, then the local headless-browser fill if Playwright is available —
     and raises a macOS notification so the owner knows the primary is down.

Silent by design: healthy runs print one line and touch nothing. Notifications
are rate-limited to one per 6 hours per condition via a small state file.

Installed by: ~/Library/LaunchAgents/com.briefing.watchdog.plist
Logs to:      ~/Library/Logs/briefing-watchdog.log (via launchd redirection)
"""
import json
import pathlib
import subprocess
import sys
import time
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import fill_content  # noqa: E402

STALE_AFTER_MIN = 75           # heartbeat is every 30 min; 75 = two misses + slack
NOTIFY_EVERY_H = 6             # don't nag more than once per condition per 6h
STATE = pathlib.Path.home() / ".briefing-watchdog-state.json"
VENV_PY = ROOT / ".venv-fill" / "bin" / "python"


def notify(msg: str, key: str) -> None:
    """macOS notification, rate-limited per condition key."""
    try:
        state = json.loads(STATE.read_text()) if STATE.exists() else {}
    except Exception:
        state = {}
    last = state.get(key, 0)
    if time.time() - last < NOTIFY_EVERY_H * 3600:
        return
    state[key] = time.time()
    try:
        STATE.write_text(json.dumps(state))
    except Exception:
        pass
    try:
        subprocess.run(["osascript", "-e",
                        f'display notification "{msg}" with title "Real Estate Briefing"'],
                       timeout=10, check=False)
    except Exception:
        pass


def main() -> int:
    now = datetime.now(timezone.utc)
    hb = fill_content.read_heartbeat()
    if hb and hb.get("lastRun"):
        try:
            last = datetime.strptime(hb["lastRun"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            age_min = (now - last).total_seconds() / 60
        except Exception:
            age_min = 10**6
    else:
        age_min = 10**6  # no pulse ever recorded

    if age_min <= STALE_AFTER_MIN:
        print(f"heartbeat fresh ({age_min:.0f} min old, via {hb.get('via')}) — nothing to do")
        return 0

    # Primary is down. Take over for today and tell the owner.
    date = fill_content._today()
    print(f"heartbeat STALE ({age_min:.0f} min) — running local failover for {date}")
    notify("Content heartbeat is stale — GitHub Actions may be down. Running local backfill.",
           "stale-heartbeat")

    # Pass 1: plain HTTP fill (stdlib only, works with system python)
    try:
        subprocess.run([sys.executable, str(ROOT / "scripts" / "fill_content.py"), date],
                       timeout=900, check=False)
    except Exception as e:  # noqa: BLE001
        print(f"HTTP fill failed: {e}")

    # Pass 2: headless-browser fill for anything still missing (needs the
    # persistent Playwright venv created at install time)
    if VENV_PY.exists():
        try:
            subprocess.run([str(VENV_PY), str(ROOT / "scripts" / "fill_browser.py"), date],
                           timeout=1800, check=False)
        except Exception as e:  # noqa: BLE001
            print(f"browser fill failed: {e}")
    else:
        print("no .venv-fill — skipping browser pass (HTTP pass only)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
