#!/usr/bin/env python3
"""Fill missing story content using a REAL headless browser (Playwright).

This is the backbone content-filler, run every 30 minutes by the GitHub Actions
workflow (.github/workflows/fill-content.yml) on GitHub's runners — machines
with unrestricted egress, independent of both the owner's hardware and the
cloud routine's sandbox (whose egress is blocked). A real browser also executes
JavaScript, so it passes the Cloudflare "Just a moment…" challenges that block
plain HTTP fetches, and it follows email tracking-link redirects (beehiiv,
Mailchimp) to the real publisher page — which lets us store the canonical URL
and credit the true source.

Idempotent and self-healing: only stories still missing content are attempted;
anything that fails is retried on the next scheduled run.

Usage:
  python3 scripts/fill_browser.py                # today (America/New_York)
  python3 scripts/fill_browser.py 2026-07-17     # a specific day
  python3 scripts/fill_browser.py --no-push      # fill local file only

Requires:  pip install playwright && playwright install chromium
"""
import json
import copy
import argparse
import os
import publication
import pathlib
import sys
import time
import urllib.parse
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import fetch_article  # extract_from_html + _session_cookie
import fill_content   # day load/push, MIN_WORDS, wrapper helpers

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
CHALLENGE_WAIT_S = 25   # max time to let Cloudflare's JS challenge resolve
SETTLE_MS = 1500        # extra settle after load for late-rendering pages


def _registrable(host: str) -> str:
    h = host.lower().removeprefix("www.")
    parts = h.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else h


def _cookies_for(url: str):
    """Parse a stored 'a=b; c=d' session header into Playwright cookies."""
    header = fetch_article._session_cookie(url)
    if not header:
        return []
    domain = "." + _registrable(urllib.parse.urlparse(url).netloc)
    out = []
    for part in header.split(";"):
        part = part.strip()
        if "=" not in part:
            continue
        name, _, value = part.partition("=")
        if name.strip():
            out.append({"name": name.strip(), "value": value.strip(),
                        "domain": domain, "path": "/"})
    return out


def fetch_with_browser(page, url: str) -> tuple[str, str]:
    """Navigate a real browser to the URL, wait out any JS challenge, and
    return (rendered_html, final_url_after_redirects)."""
    page.goto(url, wait_until="domcontentloaded", timeout=45000)
    deadline = time.time() + CHALLENGE_WAIT_S
    while time.time() < deadline:
        title = (page.title() or "").lower()
        if "just a moment" not in title and "attention required" not in title:
            break
        page.wait_for_timeout(1000)
    page.wait_for_timeout(SETTLE_MS)
    return page.content(), page.url


# How many trailing days (besides today) a no-date run also sweeps for
# stragglers. Older days rolled off "today" would otherwise never get another
# real-browser attempt; this backfills any that were missed (a Cloudflare wall
# that later clears, a wrapper the browser can now follow, a late-arriving edit).
# Set to a week: Bisnow's a-prod.bisnow.io short-links (and other redirecting
# wrappers) are intermittently down (observed live 502s), so a link can fail for
# several days before it resolves. At 4 days those aged out of the retry window
# and were never filled despite having real content; a week of retries recovers
# the flaky-then-good ones. (Hard paywalls just fail fast on each pass.)
BACKFILL_DAYS = 7


def _recent_dates(today: str) -> list[str]:
    from datetime import date as _d, timedelta
    y, m, dd = map(int, today.split("-"))
    base = _d(y, m, dd)
    return [(base - timedelta(days=i)).isoformat() for i in range(BACKFILL_DAYS + 1)]


def _fill_one_day(page, ctx, cookied: set, date: str, no_push: bool, deadline: float | None = None) -> tuple[int, int]:
    """Fill every straggler in one day with the shared browser. Returns
    (filled, failed). A day with nothing missing is a fast no-op (no fetches)."""
    day, path = fill_content.load_day(date, no_push)
    source = "local/remote" if no_push else "Supabase"
    if day is None:
        return 0, 0

    base = copy.deepcopy(day)
    stories = day.get("stories") or []
    targets = sorted((s for s in stories if fill_content.needs_enrichment(s)),
                     key=lambda s: s.get("fillAttemptedAt") or "")
    if not targets:
        return 0, 0
    print(f"{date} ({source}): {len(stories)} stories, {len(targets)} need content")

    filled, failed, changed_urls = [], [], 0
    for s in targets:
        if deadline is not None and time.monotonic() >= deadline:
            print("  Runtime budget reached; unattempted articles remain for next run")
            break
        sid = s.get("id")
        s["fillAttemptedAt"] = publication.utcnow()
        # a fabricated Bisnow short-link (descriptive slug) 404s forever — drop the
        # dead url so the app shows summary-only instead of linking to a 404
        if fetch_article.is_fabricated_bisnow_shortlink(s.get("url", "")):
            s.pop("url", None)
            s.pop("sourceBlocked", None)
            changed_urls += 1
            print(f"  ⤫ {sid:<40} dropped fabricated Bisnow short-link")
            continue
        try:
            dom = _registrable(urllib.parse.urlparse(s["url"]).netloc)
            if dom not in cookied:
                cookies = _cookies_for(s["url"])
                if cookies:
                    ctx.add_cookies(cookies)
                cookied.add(dom)
            html, final = fetch_with_browser(page, s["url"])
            res = fetch_article.extract_from_html(html, s["url"], final)
            # canonical URL: a tracking wrapper that resolved to a real page
            if final and fill_content._is_wrapper(s["url"]) and not fill_content._is_wrapper(final):
                s["url"] = fill_content._clean_url(final)
                changed_urls += 1
            have = fill_content._words(s.get("content"))
            ok = res.get("ok")
            mism = ok and fetch_article.title_mismatch(s.get("title", ""), res)
            if ok and not mism:
                got_image = False
                if not s.get("image") and res.get("image"):
                    s["image"] = res["image"]
                    got_image = True
                if res["words"] > have:
                    s["content"] = res["html"]
                    s.pop("sourceBlocked", None)
                    filled.append(sid)
                    print(f"  ✓ {sid:<40} {res['words']} words")
                elif got_image:
                    # text was already complete (e.g. from the email body); we only
                    # backfilled the missing hero image — still a change to publish
                    s.pop("sourceBlocked", None)
                    filled.append(sid)
                    print(f"  🖼 {sid:<40} image backfilled ({have} words kept)")
                elif not s.get("image"):
                    # clean fetch, no hero at source → stop re-fetching it just for art
                    s["imageChecked"] = True
                    print(f"  · {sid:<40} no image at source")
            elif mism:
                # url pointed at the wrong article — leave a tap-through, don't
                # show mismatched content under this headline
                s["sourceBlocked"] = True
                failed.append((sid, "headline/article mismatch — url likely mis-paired"))
                print(f"  ⤫ {sid:<40} headline/article mismatch")
            elif res.get("premiumData"):
                # TRD Data ($/yr tier) — no session unlocks it; clean tap-through
                s["sourceBlocked"] = True
                failed.append((sid, "TRD Data (premium tier)"))
                print(f"  ⤫ {sid:<40} TRD Data (premium tier)")
            elif have >= fill_content.MIN_WORDS:
                # here only for a missing image and the fetch missed (bot wall / error):
                # the story's text is fine — never flag it blocked, just retry next run
                print(f"  · {sid:<40} image fetch missed (text intact)")
            else:
                # Playwright got blocked/short. Before giving up, try the plain
                # HTTP + Supabase-proxy path (fetch_article.extract): sites like TRD
                # challenge the headless BROWSER from GitHub's IPs but serve the
                # article to a plain fetch through the proxy's clean egress, so the
                # "simpler" path recovers what the browser can't.
                alt = None
                try:
                    alt = fetch_article.extract(s["url"])
                except Exception:  # noqa: BLE001
                    alt = None
                if (alt and alt.get("ok")
                        and fill_content._words(alt.get("html")) > have
                        and not fetch_article.title_mismatch(s.get("title", ""), alt)):
                    s["content"] = alt["html"]
                    if not s.get("image") and alt.get("image"):
                        s["image"] = alt["image"]
                    s.pop("sourceBlocked", None)
                    filled.append(sid)
                    print(f"  ✓ {sid:<40} {alt['words']} words (http fallback)")
                else:
                    s["sourceBlocked"] = True  # app: card taps through to the source
                    failed.append((sid, f"{res.get('words', 0)} words"
                                        + (" (challenge held)" if res.get("blocked") else "")))
                    print(f"  ✗ {sid:<40} {res.get('words', 0)} words")
        except Exception as e:  # noqa: BLE001 - one bad page never stops the loop
            failed.append((sid, str(e)[:70]))
            print(f"  ✗ {sid:<40} {str(e)[:70]}")

    # Persist status/image-check-only changes too. Failure propagates to the
    # caller, which records it and keeps processing independent days.
    if not no_push:
        day = fill_content._push(day, base, "browser")
    elif day != base:
        day["generatedAt"] = publication.utcnow()
    fill_content.DATA.mkdir(exist_ok=True)
    path.write_text(json.dumps(day, ensure_ascii=False, indent=2))

    parts = [f"{date}: filled {len(filled)}/{len(targets)}"]
    if failed:
        parts.append(f"{len(failed)} still missing")
    print("  " + " · ".join(parts))
    return len(filled), len(failed)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("date", nargs="?", type=publication.validate_date)
    parser.add_argument("--no-push", action="store_true")
    args = parser.parse_args()
    no_push = args.no_push
    dates = [args.date] if args.date else _recent_dates(fill_content._today())
    worker = "github-actions" if os.environ.get("GITHUB_ACTIONS") == "true" else "browser-local"
    if not no_push:
        fill_content.record_heartbeat(dates[0], 0, 0, worker, state="started")

    # cheap pre-check: if NOTHING across the window needs content, skip launching
    # a browser entirely (the common steady-state — keeps no-op runs seconds long)
    any_targets = False
    day_priority = {}
    for date in dates:
        day, _ = fill_content.load_day(date, no_push)
        targets = [s for s in (day or {}).get("stories", []) if fill_content.needs_enrichment(s)]
        if targets:
            any_targets = True
            day_priority[date] = min(s.get("fillAttemptedAt") or "" for s in targets)
    # Oldest unattempted work across dates gets a turn even on heavy news days.
    dates.sort(key=lambda date: (day_priority.get(date, "~"), date))
    if not any_targets:
        print(f"SUMMARY: nothing to fill across {len(dates)} day(s)")
        if not no_push:
            fill_content.record_heartbeat(dates[0], 0, 0, worker)
        return 0

    from playwright.sync_api import sync_playwright  # imported late: no-op runs skip it

    deadline = time.monotonic() + 600
    total_filled = total_failed = publication_failures = 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context(user_agent=UA, locale="en-US",
                                  viewport={"width": 1280, "height": 900})
        cookied: set = set()
        page = ctx.new_page()
        for date in dates:
            if time.monotonic() >= deadline:
                print("Runtime budget reached; remaining dates deferred")
                break
            try:
                f, x = _fill_one_day(page, ctx, cookied, date, no_push, deadline)
                total_filled += f
                total_failed += x
            except Exception as exc:
                publication_failures += 1
                print(f"ERROR processing {date}: {exc}")
            if not no_push:
                fill_content.record_heartbeat(date, total_filled, total_failed, worker, state="running")
        browser.close()

    if not no_push:
        fill_content.record_heartbeat(dates[0], total_filled, total_failed, worker,
                                      state="failed" if publication_failures else "completed")
    print(f"SUMMARY: filled {total_filled}, {total_failed} still missing across {len(dates)} day(s)")

    # Source-health watchdog: after filling, check per-publisher coverage and
    # PROACTIVELY alert the owner (web push + in-app banner) if a subscriber cookie
    # expired or a fetch method collapsed. Best-effort — never fails the fill.
    try:
        if not no_push:
            import monitor_sources
            monitor_sources.main()
    except Exception as e:  # noqa: BLE001
        print(f"(monitor_sources skipped: {e})")
    return 1 if publication_failures else 0


if __name__ == "__main__":
    sys.exit(main())
