#!/usr/bin/env python3
"""Store a The Real Deal subscriber session so the cloud pipeline can fetch
subscriber articles. Two ways to run it (yourself, locally):

1. Email + password login:
     python3 scripts/trd_session.py you@example.com
   Prompts for your TRD password (hidden, never stored anywhere), logs in at
   therealdeal.com/wp-login.php, and saves ONLY the session cookies.
   Signed in through Google instead? Set a TRD password first via
   https://therealdeal.com/wp-login.php?action=lostpassword (your Google
   sign-in keeps working; the account just gains a password too).

2. Paste cookies from a browser where you're already signed in:
     python3 scripts/trd_session.py --cookie
   Then paste the cookie string when prompted. To get it: open therealdeal.com
   logged in → DevTools → Application → Cookies → copy every cookie whose name
   starts with "wordpress_" (not "wordpress_test") as "name=value; name2=value2".

Either way the cookies land in the Supabase `secrets` table (row
"trd_session") and scripts/fetch_article.py uses them automatically for any
therealdeal.com URL. WordPress sessions last ~14 days — re-run this when the
pipeline's day notes say TRD fetches hit the paywall.
"""
import getpass
import http.cookiejar
import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

SUPABASE_URL = "https://uhwdnmbxiopfysodydty.supabase.co"
ANON_KEY = "sb_publishable_LEQ5_-jjcRRl2p0wlaiXcw_RX4Wf8-y"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
LOGIN_URL = "https://therealdeal.com/wp-login.php"


def verify_and_store(cookie_header: str, how: str) -> None:
    """Confirm the cookie is a live subscriber session, then save it."""
    req = urllib.request.Request(
        "https://therealdeal.com/",
        headers={"User-Agent": UA, "Cookie": cookie_header},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        page = r.read().decode("utf-8", errors="replace")
    if "wp-login.php" in cookie_header:  # sanity: someone pasted a URL
        raise SystemExit("That looks like a URL, not a cookie string.")
    logged_in = "logout" in page.lower() or "my-account" in page.lower() or "wp-admin" in page.lower()
    if not logged_in:
        print("WARN could not positively confirm the session on the homepage — storing anyway; "
              "watch the next pipeline run's notes.")

    row = {
        "id": "trd_session",
        "data": {
            "cookie": cookie_header,
            "savedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "via": how,
            "note": "WordPress session cookies only; password is never stored.",
        },
    }
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/secrets",
        data=json.dumps(row).encode(),
        headers={
            "apikey": ANON_KEY,
            "Authorization": f"Bearer {ANON_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        assert resp.status in (200, 201)
    print("Session cookie stored. The pipeline will now fetch TRD subscriber articles automatically.")


def main() -> None:
    if "--cookie" in sys.argv:
        print("Paste the cookie string from your logged-in browser")
        print('(DevTools → Application → Cookies → therealdeal.com; every "wordpress_*" cookie as name=value; name2=value2):')
        cookie = input("> ").strip().strip('"')
        if not cookie or "=" not in cookie:
            raise SystemExit("That doesn't look like a cookie string.")
        verify_and_store(cookie, "pasted-cookie")
        return

    email = sys.argv[1] if len(sys.argv) > 1 else input("TRD account email: ").strip()
    password = getpass.getpass("TRD password (hidden, used once, never stored): ")

    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = [("User-Agent", UA), ("Referer", LOGIN_URL)]

    # prime cookies (WP sets a test cookie on GET)
    opener.open(LOGIN_URL, timeout=30)

    form = urllib.parse.urlencode({
        "log": email,
        "pwd": password,
        "rememberme": "forever",
        "wp-submit": "Log In",
        "redirect_to": "https://therealdeal.com/",
        "testcookie": "1",
    }).encode()
    opener.open(LOGIN_URL, data=form, timeout=30)

    session_cookies = {c.name: c.value for c in jar if "wordpress" in c.name.lower() and "test" not in c.name.lower()}
    if not any("logged_in" in n for n in session_cookies):
        raise SystemExit(
            "Login failed — no wordpress_logged_in cookie returned.\n"
            "If your TRD account uses Google sign-in, either set a password first via\n"
            "https://therealdeal.com/wp-login.php?action=lostpassword (Google sign-in keeps working),\n"
            "or run: python3 scripts/trd_session.py --cookie   and paste cookies from your browser."
        )

    cookie_header = "; ".join(f"{n}={v}" for n, v in session_cookies.items())
    print(f"Logged in as {email} ({len(session_cookies)} session cookies).")
    verify_and_store(cookie_header, "wp-login")


if __name__ == "__main__":
    main()
