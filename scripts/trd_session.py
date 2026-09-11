#!/usr/bin/env python3
"""Store a The Real Deal subscriber session so the cloud pipeline can fetch
subscriber articles.

TRD's reader site is a Next.js app with its own login/subscription system —
it is NOT WordPress auth, so a scripted email+password login does not work
(wp-login.php doesn't know your reader account). The reliable way is to copy
the session cookies from a browser where you're already signed in (via Google
or password, either is fine).

HOW TO RUN IT (yourself, locally):

  python3 scripts/trd_session.py --cookie [optional-article-url]

  Then paste your therealdeal.com cookie string. To get it:
    1. Sign in at therealdeal.com in your browser.
    2. Open DevTools (Cmd+Opt+I) → Network tab → reload the page.
    3. Click the top document request → Headers → Request Headers →
       copy the entire value of the "cookie:" line.
    (Copying the whole cookie header is the robust move — it captures whatever
     cookie TRD uses to gate articles, without guessing names.)

  If you pass an article URL, the script test-fetches it with your cookies and
  reports the word count so you can confirm it beat the paywall before saving.

The cookies land in the Supabase `secrets` table (row "trd_session") and
scripts/fetch_article.py uses them automatically for any therealdeal.com URL.
Sessions expire after a couple of weeks — re-run this when the pipeline's day
notes say TRD fetches hit the paywall.

(Legacy: `python3 scripts/trd_session.py you@example.com` still attempts a
WordPress login for the rare account that has one, but --cookie is preferred.)
"""
import getpass
import hashlib
import http.cookiejar
import json
import os
import secrets
import subprocess
import tempfile
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

SUPABASE_URL = "https://uhwdnmbxiopfysodydty.supabase.co"
ANON_KEY = "sb_publishable_LEQ5_-jjcRRl2p0wlaiXcw_RX4Wf8-y"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
LOGIN_URL = "https://therealdeal.com/wp-login.php"


def _article_words(url: str, cookie_header: str) -> int:
    """Fetch an article with the cookie and count visible words (rough paywall test)."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Cookie": cookie_header, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=30) as r:
        html = r.read().decode("utf-8", errors="replace")
    # count words inside <p> tags only — the article body
    paras = re.findall(r"<p[^>]*>(.*?)</p>", html, re.S)
    text = re.sub(r"<[^>]+>", " ", " ".join(paras))
    return len(text.split())


def _domain() -> str:
    """--domain <site> stores a session for any outlet (default therealdeal.com).
    e.g.  python3 scripts/trd_session.py --cookie --domain bisnow.com"""
    args = sys.argv[1:]
    if "--domain" in args:
        d = args[args.index("--domain") + 1].lower().removeprefix("www.")
        return d
    return "therealdeal.com"


def owner_secret() -> str:
    secret = os.environ.get("AUDIT_PIPELINE_SECRET", "").strip()
    if not secret:
        raise SystemExit("Owner capture requires AUDIT_PIPELINE_SECRET in your local environment. Never paste this credential into the app. Ask the operator to configure it, then retry.")
    return secret


def _cli_ticket(domain: str) -> str:
    """Use the operator's existing CLI login; never extract or expose its credential."""
    token = secrets.token_hex(32)
    digest = hashlib.sha256(token.encode()).hexdigest()
    # Inputs are an exact domain allowlist and a generated hexadecimal hash.
    sql = f"select public.issue_capture_ticket('{digest}', '{domain}') as issued;\n"
    try:
        with tempfile.TemporaryDirectory(prefix="cre-capture-") as directory:
            path = os.path.join(directory, "issue.sql")
            with open(path, "w", encoding="utf-8") as output:
                output.write(sql)
            result = subprocess.run(
                ["supabase", "db", "query", "--linked", "--project-ref", "uhwdnmbxiopfysodydty",
                 "--file", path],
                capture_output=True, text=True, timeout=30, check=False,
            )
        if result.returncode != 0:
            raise ValueError("CLI failed")
        response = json.loads(result.stdout)
        rows = response.get("rows") if isinstance(response, dict) else None
        if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict) or rows[0].get("issued") is not True:
            raise ValueError("Invalid acknowledgment")
    except (OSError, subprocess.SubprocessError, ValueError, TypeError):
        raise SystemExit("Could not confirm ticket issuance. Sign in to the Supabase CLI with the owner account and retry. No reusable credential was displayed.") from None
    return token


def issue_ticket() -> None:
    domain = _domain()
    if domain not in {"therealdeal.com", "inman.com", "bisnow.com"}:
        raise SystemExit("Unsupported publisher for owner capture.")
    if not os.environ.get("AUDIT_PIPELINE_SECRET", "").strip():
        token = _cli_ticket(domain)
    else:
        req = urllib.request.Request(
            f"{SUPABASE_URL}/functions/v1/store-session",
            data=json.dumps({"action": "issue-ticket", "domain": domain}).encode(),
            headers={"apikey": ANON_KEY, "Content-Type": "application/json", "x-audit-secret": owner_secret()},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.load(resp)
        if not body.get("ok") or body.get("domain") != domain or not re.fullmatch(r"[a-f0-9]{64}", str(body.get("captureToken", ""))):
            raise SystemExit("Could not issue an owner capture ticket.")
        token = body["captureToken"]
    print(f"One-use capture ticket for {domain} (expires in 10 minutes):")
    print(token)


def store(cookie_header: str, how: str) -> None:
    domain = _domain()
    # The cookie vault denies the public key writes, so capture routes through the
    # store-session edge function (service role). It upserts the cookie into
    # `secrets` and the non-secret health into public `app_status` in one call.
    req = urllib.request.Request(
        f"{SUPABASE_URL}/functions/v1/store-session",
        data=json.dumps({"domain": domain, "cookie": cookie_header, "via": how}).encode(),
        headers={
            "apikey": ANON_KEY,
            "Authorization": f"Bearer {ANON_KEY}",
            "Content-Type": "application/json",
            "x-audit-secret": owner_secret(),
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.load(resp)
    if not body.get("ok"):
        raise SystemExit(f"store-session failed: {body.get('error')}")
    print(f"Session cookie stored ({body.get('cookieLen')} chars). The pipeline will now use it for {domain} articles.")


def run_cookie_mode() -> None:
    test_url = None
    for arg in sys.argv[1:]:
        if arg.startswith("http"):
            test_url = arg
    print("Paste your therealdeal.com cookie string (the whole 'cookie:' request header):")
    cookie = input("> ").strip().strip('"').strip("'")
    if cookie.lower().startswith("cookie:"):
        cookie = cookie[len("cookie:"):].strip()
    if not cookie or "=" not in cookie:
        raise SystemExit("That doesn't look like a cookie string.")

    if test_url:
        try:
            n = _article_words(test_url, cookie)
            print(f"Test fetch of {test_url}: {n} words in the article body.")
            if n < 150:
                print("WARN that's short — the cookie may not be unlocking full articles. "
                      "Double-check you copied the whole cookie header while signed in.")
        except Exception as e:  # noqa: BLE001
            print(f"WARN test fetch failed ({e}); storing the cookie anyway.")
    else:
        print("Tip: re-run with a subscriber article URL to verify, e.g.\n"
              "  python3 scripts/trd_session.py --cookie https://therealdeal.com/new-york/2026/07/15/<slug>/")
    store(cookie, "pasted-cookie")


def run_login_mode() -> None:
    email = sys.argv[1]
    password = getpass.getpass("TRD password (hidden, used once, never stored): ")
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = [("User-Agent", UA), ("Referer", LOGIN_URL)]
    opener.open(LOGIN_URL, timeout=30)  # prime test cookie
    form = urllib.parse.urlencode({
        "log": email, "pwd": password, "rememberme": "forever",
        "wp-submit": "Log In", "redirect_to": "https://therealdeal.com/", "testcookie": "1",
    }).encode()
    opener.open(LOGIN_URL, data=form, timeout=30)
    session_cookies = {c.name: c.value for c in jar if "wordpress" in c.name.lower() and "test" not in c.name.lower()}
    if not any("logged_in" in n for n in session_cookies):
        raise SystemExit(
            "WordPress login failed (TRD's reader accounts usually aren't WordPress users).\n"
            "Use the cookie method instead:\n"
            "  python3 scripts/trd_session.py --cookie\n"
            "and paste the cookie header from your signed-in browser (see the header of this file)."
        )
    cookie_header = "; ".join(f"{n}={v}" for n, v in session_cookies.items())
    print(f"Logged in as {email} ({len(session_cookies)} session cookies).")
    store(cookie_header, "wp-login")


def main() -> None:
    if "--issue-ticket" in sys.argv:
        issue_ticket()
    elif "--cookie" in sys.argv:
        owner_secret()
        run_cookie_mode()
    elif len(sys.argv) > 1 and "@" in sys.argv[1]:
        run_login_mode()
    else:
        print(__doc__)
        sys.exit(0)


if __name__ == "__main__":
    main()
