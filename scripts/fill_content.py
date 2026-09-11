#!/usr/bin/env python3
"""Deterministically fill every story's reader content for a day.

The daily routine writes the day file with each story's `url`; THIS script then
loops over EVERY story and fetches full article text for any that is missing or
too short — through scripts/fetch_article.py (direct → Supabase proxy → TRD
cookie). It takes article-fetching OFF the agent's judgment and makes it a
guaranteed loop, so no story is ever silently left as a summary-only stub.

It is idempotent: only stories still lacking real content get fetched, so it is
safe (and cheap) to run at every scheduled window. A story whose fetch failed
transiently is simply retried on the next run — that cross-run retry is what
makes coverage reliable without any manual step.

Usage:
  python3 scripts/fill_content.py                 # today (America/New_York)
  python3 scripts/fill_content.py 2026-07-16      # a specific day
  python3 scripts/fill_content.py 2026-07-16 --no-push   # fill local file only, don't publish

Exit status is 0 on a clean run; it prints a per-story report and a summary
line like "filled 14/16 · 2 failed (ids…)" so the routine can fold any
persistent failure into the day's notes.
"""
import json
import copy
import argparse
import publication
import pathlib
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from content_quality import assess_content
import fetch_article  # same directory; provides extract(url) -> {ok, html, image, words, [paywalled]}

SUPABASE_URL = "https://uhwdnmbxiopfysodydty.supabase.co"
ANON_KEY = "sb_publishable_LEQ5_-jjcRRl2p0wlaiXcw_RX4Wf8-y"

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# A story "has content" once it holds at least this many words — matches
# fetch_article's own ok bar, so we never overwrite a real body with a shorter
# one and never leave a genuine stub unfilled.
MIN_WORDS = 120

# Email tracking-link wrappers: the stored `url` is opaque and points here, not
# at the publisher. Once a fetch resolves the redirect we swap in the real URL so
# the app can credit the actual publisher (and "Source ↗" skips the redirect).
WRAPPERS = ("list-manage.com", "beehiiv.com", "mailchi.mp")


def _words(html: str | None) -> int:
    if not html:
        return 0
    return len(re.sub(r"<[^>]+>", " ", html).split())


def _host(url: str) -> str:
    try:
        return urllib.parse.urlparse(url if isinstance(url, str) else "").netloc.lower()
    except Exception:
        return ""


def _is_wrapper(url: str) -> bool:
    h = _host(url)
    return any(w in h for w in WRAPPERS)


def _clean_url(url: str) -> str:
    """Drop query/fragment tracking so the stored publisher URL is canonical."""
    try:
        p = urllib.parse.urlparse(url)
        return urllib.parse.urlunparse((p.scheme, p.netloc, p.path, "", "", ""))
    except Exception:
        return url


def _registrable(url: str) -> str:
    parts = _host(url).removeprefix("www.").split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else _host(url)


# Subscriber sites whose session can genuinely expire — the app surfaces these in
# its Connections panel and prompts a one-tap reconnect. (Bisnow fetches free, so
# it never flags; only a real session-gated wall trips this.)
SESSION_DOMAINS = {"therealdeal.com"}


def flag_reconnect(domain: str, needs: bool) -> None:
    """Publish session health to the public app_status table so the app can
    proactively prompt a reconnect (needs=True) or clear it after a good fetch
    (needs=False). Non-secret, anon-writable; never fatal."""
    if domain not in SESSION_DOMAINS:
        return
    try:
        # preserve savedAt (set by store-session on capture) so the app keeps
        # showing "cookie saved X ago"; we only flip the health flag here
        prev = {}
        try:
            greq = urllib.request.Request(
                f"{SUPABASE_URL}/rest/v1/app_status?id=eq.conn_{domain}&select=data",
                headers={"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}"})
            rows = json.load(urllib.request.urlopen(greq, timeout=15))
            prev = (rows[0]["data"] if rows else {}) or {}
        except Exception:
            prev = {}
        if prev.get("needsReconnect") == bool(needs):
            return  # no change — don't churn the row
        data = dict(prev)
        data.update({"domain": domain, "needsReconnect": bool(needs),
                     "checkedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/app_status",
            data=json.dumps({"id": f"conn_{domain}", "data": data}).encode(),
            headers={"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}",
                     "Content-Type": "application/json",
                     "Prefer": "resolution=merge-duplicates,return=minimal"},
            method="POST")
        urllib.request.urlopen(req, timeout=15).read()
    except Exception:
        pass  # a health blip must never break a fill run


def _today() -> str:
    return datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")


def record_heartbeat(date: str, filled: int, failed: int, via: str, state: str = "completed") -> None:
    """Pulse for the failover chain: every filler run (even a no-op) upserts a
    status row so the cloud routine and the Mac watchdog can detect a dead
    primary (GitHub Actions) and take over. Never fatal."""
    import os
    worker = via or ("github-actions" if os.environ.get("GITHUB_ACTIONS") == "true" else "local")
    row = {"id": "fill_" + worker, "data": {
        "lastRun": publication.utcnow(), "date": date,
        "filled": filled, "failed": failed, "via": worker, "state": state,
        "runId": os.environ.get("GITHUB_RUN_ID"),
    }}
    try:
        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/publication_workers", data=json.dumps(row).encode(),
            headers={"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}",
                     "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates"},
            method="POST")
        urllib.request.urlopen(req, timeout=15).read()
    except Exception as exc:
        print(f"  WARN worker status unavailable: {exc}")


def read_heartbeat() -> dict | None:
    """The last pulse, or None. Used by fallbacks to decide whether to act."""
    try:
        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/publication_workers?id=eq.fill_github-actions&select=data",
            headers={"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}"})
        rows = json.load(urllib.request.urlopen(req, timeout=15))
        return rows[0]["data"] if rows and rows[0]["data"].get("state") in ("started", "running", "completed") else None
    except Exception:
        return None


def _load_local(date: str) -> tuple[dict | None, pathlib.Path]:
    path = DATA / f"{date}.json"
    if path.exists():
        return json.loads(path.read_text()), path
    return None, path


def _load_supabase(date: str) -> dict | None:
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/days?date=eq.{date}&select=data",
        headers={"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        rows = json.load(r)
    return rows[0]["data"] if rows else None


def _push(day: dict, base: dict, worker: str = "http") -> dict:
    return publication.publish_enrichment(base, day, worker)


def load_day(date: str, no_push: bool = False):
    publication.validate_date(date)
    path = DATA / f"{date}.json"
    if no_push:
        local, path = _load_local(date)
        if local is not None:
            return local, path
    # A publication run always begins with current remote data. A stale local
    # file must never determine which article/source gets fetched.
    return _load_supabase(date), path


def needs_enrichment(story):
    return bool(story.get("url") or any(c.get("url") for c in (story.get("coverage") or []) if isinstance(c, dict))) and (
        not assess_content(story.get("content"))["ready"]
        or (not story.get("image") and not story.get("imageChecked")))


def stamp_content_status(story, error=None):
    quality = assess_content(story.get("content"))
    story["contentStatus"] = quality["status"]
    if quality["ready"]:
        story.pop("fillError", None)
    else:
        story.pop("contentReadyAt", None)
        story["fillError"] = error or quality["reason"]


def _try_primary(s: dict) -> tuple[str, object]:
    """Attempt to fill one story's content. Mutates it on success.
    Returns (status, detail) where status is 'filled'|'paywalled'|'failed'."""
    have = _words(s.get("content"))
    # a fabricated Bisnow short-link (descriptive slug, not a hex id) 404s forever;
    # drop the dead url so the app shows the story summary-only instead of linking
    # the reader to a 404 page. (The routine should never mint these — see CLAUDE.md.)
    if fetch_article.is_fabricated_bisnow_shortlink(s.get("url", "")):
        s.pop("url", None)
        s.pop("sourceBlocked", None)
        return "dropped", "removed fabricated Bisnow short-link (would 404)"
    try:
        res = fetch_article.extract(s["url"])
    except Exception as e:  # noqa: BLE001
        return "failed", f"fetch error: {str(e)[:70]}"
    # credit the real publisher: if the stored url was a tracking wrapper and the
    # fetch resolved to a real destination, swap in the canonical publisher URL
    final = res.get("finalUrl")
    if final and _is_wrapper(s["url"]) and not _is_wrapper(final):
        s["url"] = _clean_url(final)
    if res.get("ok"):
        mism = fetch_article.title_mismatch(s.get("title", ""), res)
        improved = not assess_content(s.get("content"))["ready"] or _words(res.get("html")) > have
        # guard against a mis-paired link: if the headline shares no distinctive
        # name with the fetched article, the url pointed at the wrong story —
        # don't attach that content (or its image) under this headline
        if improved and mism:
            return "mismatch", "fetched article doesn't match the headline — url likely mis-paired (leaving as a tap-through)"
        got_image = False
        if not mism and not s.get("image") and res.get("image"):
            s["image"] = res["image"]
            got_image = True
        if improved and not mism:
            s["content"] = res["html"]
            return "filled", res["words"]
        # content wasn't improved (the story already had fuller text — e.g. lifted
        # from the email body) but we may have just backfilled a missing image
        if got_image:
            return "imageonly", f"image backfilled ({have} words kept)"
        if not s.get("image"):
            # a clean fetch that yielded no usable hero — record it so the
            # image-missing target below stops re-fetching this story forever
            s["imageChecked"] = True
            return "nochange", "no image at source"
    if res.get("notFound"):
        return "failed", "404 at source — the story's url looks wrong (never guess urls; use the email's link)"
    if res.get("premiumData"):
        s["sourceBlocked"] = True  # app: clean tap-through to the (paywalled) source
        return "premium", "TRD Data (premium tier) — no session unlocks it; left as a tap-through"
    if res.get("paywalled"):
        return "paywalled", None
    if res.get("blocked"):
        return "blocked", "bot wall (Cloudflare) — auto-retries next run"
    return "failed", f"only {res.get('words', 0)} words"


def _try_coverage(s: dict) -> bool:
    """Recover from an already verified coverage link, preserving source attribution."""
    if assess_content(s.get("content"))["ready"]:
        return False
    for entry in list(s.get("coverage") or []):
        if not isinstance(entry, dict):
            continue
        url = entry.get("url")
        if not url or url == s.get("url") or _host(url) == "" or not url.startswith(("https://", "http://")):
            continue
        try:
            result = fetch_article.extract(url)
        except Exception:
            continue
        if not result.get("ok") or not assess_content(result.get("html"))["ready"] or fetch_article.title_mismatch(s.get("title", ""), result):
            continue
        old = {"publisher": s.get("publisher") or _host(s.get("url", "")), "url": s.get("url"),
               "title": s.get("title"), "content": s.get("content"), "note": None}
        final = result.get("finalUrl") or url
        remaining = [c for c in (s.get("coverage") or []) if isinstance(c, dict) and c is not entry]
        if old["url"] and not any(c.get("url") == old["url"] for c in remaining):
            remaining.append(old)
        s["coverage"] = remaining
        s["url"] = _clean_url(final)
        s["publisher"] = entry.get("publisher") or _host(final)
        s["content"] = result["html"]
        # An alternate outlet's article image must remain credited to that outlet.
        s["image"] = result.get("image")
        s.pop("sourceBlocked", None)
        s.pop("imageChecked", None)
        return True
    return False


def _try_story(s: dict) -> tuple[str, object]:
    result = _try_primary(s) if s.get("url") else ("failed", "missing_source_url")
    if result[0] not in ("filled", "imageonly", "nochange") and _try_coverage(s):
        return "filled", _words(s.get("content"))
    return result


def fill_day(day: dict, throttle: float = 1.5, retry_wait: float = 25, max_seconds: float = 600) -> dict:
    """Fetch content for every story that still needs it. Mutates `day` in place.

    Fetches are spaced out (`throttle`) so a burst never trips the tracking-link
    hosts' per-IP rate limit (beehiiv/Mailchimp 403 under rapid repeat hits), and
    any story that still failed gets ONE retry pass after `retry_wait` — long
    enough for a rate-limit window to reset. Whatever remains failed is a genuine
    miss that the next scheduled run will retry again.

    Returns a report: {filled, failed, paywalled, skipped, attempted}."""
    deadline = time.monotonic() + max_seconds
    stories = day.get("stories") or []
    # briefs render compactly in the feed but still get full text — every story
    # with a url deserves a reader page
    # fetch a story that still needs TEXT (under MIN_WORDS) OR one that has text but
    # is still missing a hero IMAGE and hasn't already been checked — a story that
    # arrived text-complete from the email body (CRE Daily often does) would
    # otherwise never be revisited to grab its og:image.
    to_fetch = [s for s in stories if needs_enrichment(s)]
    to_fetch.sort(key=lambda s: s.get("fillAttemptedAt") or "")
    skipped = len(stories) - len(to_fetch)
    filled, paywalled, dropped = [], [], []
    attempted_ids = set()
    unresolved = {}  # id -> (kind, detail); kind in {"blocked", "failed"}

    def run_pass(items: list, tag: str) -> None:
        for i, s in enumerate(items):
            if time.monotonic() >= deadline:
                print("  Runtime budget reached; remaining articles deferred")
                break
            if i:
                time.sleep(throttle)  # space out to dodge tracking-link rate limits
            sid = s.get("id")
            attempted_ids.add(sid)
            s["fillAttemptedAt"] = publication.utcnow()
            status, detail = _try_story(s)
            stamp_content_status(s, None if status in ("filled", "imageonly", "nochange") else status)
            if status == "filled":
                filled.append(sid)
                unresolved.pop(sid, None)
                # a good subscriber fetch proves the session is live — clear any
                # stale reconnect flag so the app's nudge self-heals
                flag_reconnect(_registrable(s.get("url", "")), False)
                print(f"  ✓ {sid:<40} {detail} words{tag}")
            elif status == "imageonly":
                # text was already complete; we only backfilled the missing hero
                filled.append(sid)   # a real change → republish
                unresolved.pop(sid, None)
                print(f"  🖼 {sid:<40} {detail}{tag}")
            elif status == "nochange":
                # clean fetch, nothing new to add (and no image at source) — not a
                # failure; imageChecked is now set so we won't re-fetch it for art
                unresolved.pop(sid, None)
            elif status == "paywalled":
                if sid not in paywalled:
                    paywalled.append(sid)
                unresolved.pop(sid, None)
                # genuine session-gated wall — prompt a reconnect in the app
                flag_reconnect(_registrable(s.get("url", "")), True)
                print(f"  ⚠ {sid:<40} TRD paywalled (session expired)")
            elif status == "blocked":
                unresolved[sid] = ("blocked", detail)
                print(f"  ⛔ {sid:<40} {detail}{tag}")
            elif status == "dropped":
                # a fabricated url was removed from the story — a change worth
                # publishing so the app stops dead-linking to it
                dropped.append(sid)
                unresolved.pop(sid, None)
                print(f"  ⤫ {sid:<40} {detail}")
            elif status in ("mismatch", "premium"):
                # deterministic — a wrong-url pairing or a premium-tier page no
                # session can unlock; don't retry, leave a clean tap-through
                unresolved.pop(sid, None)
                print(f"  ⤫ {sid:<40} {detail}")
            else:
                unresolved[sid] = ("failed", detail)
                print(f"  ✗ {sid:<40} {detail}{tag}")

    run_pass(to_fetch, "")
    retry = [s for s in to_fetch if s.get("id") in unresolved]
    if retry and time.monotonic() + retry_wait < deadline:
        print(f"  … retrying {len(retry)} after {retry_wait:.0f}s (rate-limit / bot-wall may clear)")
        time.sleep(retry_wait)
        run_pass(retry, "  (retry)")

    if filled or dropped:
        day["generatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    blocked = [(i, d) for i, (k, d) in unresolved.items() if k == "blocked"]
    failed = [(i, d) for i, (k, d) in unresolved.items() if k == "failed"]

    # Flag stories whose full text lives at a source we were blocked from: the app
    # turns those cards into a tap-through to the source (category C). Cleared once a
    # story has real in-app text, or is just a self-contained blurb (category B).
    blocked_ids = {i for i, _ in blocked}
    for s in to_fetch:
        if s.get("id") not in attempted_ids:
            continue
        if assess_content(s.get("content"))["ready"]:
            s.pop("sourceBlocked", None)
        elif s.get("id") in blocked_ids:
            s["sourceBlocked"] = True
        else:
            s.pop("sourceBlocked", None)

    return {"filled": filled, "failed": failed, "blocked": blocked, "paywalled": paywalled,
            "dropped": dropped, "skipped": skipped, "attempted": len(attempted_ids)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("date", nargs="?", type=publication.validate_date, default=_today())
    parser.add_argument("--no-push", action="store_true")
    args = parser.parse_args()
    date, no_push = args.date, args.no_push
    day, path = load_day(date, no_push)
    source = "local/remote" if no_push else "Supabase"
    if day is None:
        print(f"No day found for {date} (checked local file and Supabase).")
        return 1

    print(f"Filling content for {date}  (loaded from {source}, {len(day.get('stories') or [])} stories)")
    base = copy.deepcopy(day)
    if not no_push:
        record_heartbeat(date, 0, 0, "http", state="started")
    rep = fill_day(day)

    if not no_push:
        try:
            day = _push(day, base, "http")
            print("  published enrichment against current Supabase data")
        except Exception as e:
            record_heartbeat(date, 0, len(rep["failed"]), "http", state="failed")
            print(f"  ERROR publication failed: {e}")
            return 1
    if no_push and day != base:
        day["generatedAt"] = publication.utcnow()
    DATA.mkdir(exist_ok=True)
    path.write_text(json.dumps(day, ensure_ascii=False, indent=2))
    if not no_push:
        record_heartbeat(date, len(rep["filled"]), len(rep["failed"]) + len(rep["blocked"]), "http")

    # summary line the routine can read at a glance
    parts = [f"filled {len(rep['filled'])}/{rep['attempted']}"]
    if rep["blocked"]:
        parts.append(f"{len(rep['blocked'])} bot-walled, auto-retries next run ({', '.join(i or '?' for i, _ in rep['blocked'])})")
    if rep["failed"]:
        parts.append(f"{len(rep['failed'])} failed ({', '.join(i or '?' for i, _ in rep['failed'])})")
    if rep["paywalled"]:
        parts.append(f"{len(rep['paywalled'])} TRD-paywalled — refresh with: python3 scripts/trd_session.py --cookie")
    if rep.get("dropped"):
        parts.append(f"{len(rep['dropped'])} dropped fabricated Bisnow url ({', '.join(rep['dropped'])})")
    print("SUMMARY: " + " · ".join(parts) + f" · {rep['skipped']} already had content")
    return 0


if __name__ == "__main__":
    sys.exit(main())
