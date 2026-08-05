#!/usr/bin/env python3
"""
monitor_sources.py — source-health watchdog + PROACTIVE admin alerts.

The failure the owner must never discover by accident: articles silently stop
getting in-app text because a subscriber cookie expired or a fetch method broke.
This closes that gap. It reads the last few PUBLISHED days from Supabase, computes
per-publisher content-fill rates, and detects two actionable failure modes:

  1. SESSION EXPIRED — a session-gated site (The Real Deal) whose fill rate has
     collapsed. Almost always an expired cookie → the owner must run
     `python3 scripts/trd_session.py --cookie`.
  2. METHOD BROKEN — a normally-reliable source (CRE Daily, Bisnow) collapsing,
     i.e. a wall changed / a fetch path died and the HTTP+proxy fallbacks aren't
     covering it. The owner should investigate the pipeline.

On a NEW problem (state transition, not every run) it:
  (a) flips the app's reconnect banner via the public `app_status` table, and
  (b) sends a WEB PUSH to the owner via the `push-send` edge function — so the
      owner is TOLD, on their phone, without opening the app.

Reads Supabase only (so it runs from the egress-blocked cloud sandbox too). It is
the redundancy backstop for content fetching: if one approach stops working, this
surfaces it immediately instead of weeks later.

Usage:  python3 scripts/monitor_sources.py [--days N] [--no-push] [--force]
"""
import json, re, sys, urllib.request
from urllib.parse import urlparse
from collections import defaultdict
from datetime import datetime, timezone

# ---- creds (read from push_data.py, same as the scanners) --------------------
_src = open(__file__.rsplit("/", 1)[0] + "/push_data.py").read()
URL = re.search(r"https://[a-z0-9]+\.supabase\.co", _src).group(0)
KEY = re.search(r"sb_publishable_[A-Za-z0-9_-]+", _src).group(0)
_H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}

DAYS = int(sys.argv[sys.argv.index("--days") + 1]) if "--days" in sys.argv else 3
NO_PUSH = "--no-push" in sys.argv
FORCE = "--force" in sys.argv
OWNER = "matthew"                       # admin profile to push

# session-gated sites: a collapse here means "refresh the cookie"
SESSION_SITES = {
    "therealdeal.com": "The Real Deal — run scripts/trd_session.py --cookie",
}
# sites we expect to fill reliably; a collapse means a fetch method broke
RELIABLE_SITES = {"credaily.com", "bisnow.com", "a-prod.bisnow.io", "inman.com"}
# hard paywalls we CANNOT fetch — excluded from health (a 0% here is expected,
# not a failure), so they never raise a false alarm.
HARD_WALLED = {"globest.com", "wsj.com", "bloomberg.com", "costar.com",
               "commercialobserver.com", "nytimes.com"}
COLLAPSE_RATE = 0.34                     # below a third filled = collapsed
MIN_SAMPLE = 4                           # need at least this many stories to judge


def _get(path):
    return json.load(urllib.request.urlopen(urllib.request.Request(f"{URL}/rest/v1/{path}", headers=_H), timeout=30))


def _words(html):
    return 0 if not html else len(re.sub("<[^>]+>", " ", html).split())


def _dom(u):
    try:
        d = urlparse(u).netloc.lower()
        return d[4:] if d.startswith("www.") else d
    except Exception:
        return "?"


def _post(path, body, extra=None):
    h = dict(_H); h["Content-Type"] = "application/json"
    if extra:
        h.update(extra)
    req = urllib.request.Request(f"{URL}/{path}", data=json.dumps(body).encode(), headers=h, method="POST")
    return urllib.request.urlopen(req, timeout=20).read()


def flag_reconnect(domain, needs):
    """Flip the app's session-health banner (mirrors fill_content.flag_reconnect)."""
    try:
        rows = _get(f"app_status?id=eq.conn_{domain}&select=data")
        prev = (rows[0]["data"] if rows else {}) or {}
        if prev.get("needsReconnect") == bool(needs):
            return
        data = dict(prev)
        data.update({"domain": domain, "needsReconnect": bool(needs),
                     "checkedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
        _post("rest/v1/app_status", {"id": f"conn_{domain}", "data": data},
              {"Prefer": "resolution=merge-duplicates,return=minimal"})
    except Exception as e:  # noqa: BLE001
        print(f"  (flag_reconnect {domain} failed: {e})")


def push_admin(title, body):
    if NO_PUSH:
        print(f"  [--no-push] would push: {title} — {body}")
        return
    try:
        _post("functions/v1/push-send", {"profiles": [OWNER], "title": title,
              "body": body, "url": "#/status", "tag": "admin-health"})
        print(f"  → pushed admin alert: {title}")
    except Exception as e:  # noqa: BLE001
        print(f"  (push failed: {e})")


def main():
    days = _get(f"days?select=date&order=date.desc&limit={DAYS}")
    dates = [d["date"] for d in days]
    stat = defaultdict(lambda: [0, 0])   # domain -> [total_with_url, filled]
    for d in dates:
        row = _get(f"days?date=eq.{d}&select=data")[0]["data"]
        for s in row.get("stories", []):
            if not s.get("url"):
                continue
            dom = _dom(s["url"])
            stat[dom][0] += 1
            stat[dom][1] += 1 if _words(s.get("content")) >= 120 else 0

    problems = []            # list of (key, human_message)
    for dom, (tot, fil) in stat.items():
        if dom in HARD_WALLED or tot < MIN_SAMPLE:
            continue
        rate = fil / tot
        if rate < COLLAPSE_RATE:
            if dom in SESSION_SITES:
                problems.append((f"session:{dom}",
                                 f"{SESSION_SITES[dom]} ({fil}/{tot} filled)"))
            elif dom in RELIABLE_SITES:
                problems.append((f"method:{dom}",
                                 f"{dom} fetch collapsed ({fil}/{tot}) — a method broke"))

    # report
    print(f"Source health over {dates[-1]}..{dates[0]}:")
    for dom, (tot, fil) in sorted(stat.items(), key=lambda x: -x[1][0]):
        if tot >= MIN_SAMPLE:
            tag = " HARD-WALL" if dom in HARD_WALLED else (" ⚠" if fil / tot < COLLAPSE_RATE and dom not in HARD_WALLED else "")
            print(f"  {dom:28} {fil}/{tot}{tag}")

    # de-dupe: only push on NEWLY-appeared problems (state transition)
    prev_keys = set()
    try:
        rows = _get("app_status?id=eq.source_health&select=data")
        prev_keys = set((rows[0]["data"] if rows else {}).get("problemKeys", []))
    except Exception:
        pass
    keys = {k for k, _ in problems}
    fresh = keys - prev_keys if not FORCE else keys

    # persist current health (metadata only; the app can surface it)
    _post("rest/v1/app_status",
          {"id": "source_health", "data": {
              "checkedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
              "problemKeys": sorted(keys),
              "problems": [m for _, m in problems],
              "window": f"{dates[-1]}..{dates[0]}"}},
          {"Prefer": "resolution=merge-duplicates,return=minimal"})

    # session collapses also flip the per-site reconnect banner (both directions)
    for dom in SESSION_SITES:
        flag_reconnect(dom, f"session:{dom}" in keys)

    if not problems:
        print("✓ all fetchable sources healthy")
        return 0

    print(f"\n⚠ {len(problems)} problem(s):")
    for _, m in problems:
        print("  •", m)

    if fresh:
        session_hit = [m for k, m in problems if k.startswith("session:") and k in fresh]
        method_hit = [m for k, m in problems if k.startswith("method:") and k in fresh]
        if session_hit:
            push_admin("⚠ Subscriber session expired",
                       session_hit[0] + " — articles are going text-less until you refresh it.")
        if method_hit:
            push_admin("⚠ Article fetching is failing",
                       method_hit[0] + ". Check the pipeline / GitHub Actions.")
    else:
        print("  (already alerted — no new push)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
