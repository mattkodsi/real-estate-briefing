#!/usr/bin/env python3
"""
scan_sort.py — deterministic surfacer for MIS-BRIEFED stories (the card/brief sort).

The daily routine decides card-vs-brief by a holistic ranking each run. That is a
judgment call, and the failure mode the reader fears is a *quiet* one: a genuinely
relevant story left in "Also today" that never gets promoted, discovered weeks
later. This script removes the judgment for the objective cases: it mechanically
re-checks every published BRIEF against the step-4 "auto-card floor" triggers and
prints the ones that should have been cards, so a mis-brief is caught THIS run.

It is a FLOOR, not a ceiling — high recall on the objective triggers, precision
left to the routine (each flag is promoted to a card, or justified as a genuine
near-dup of one already carded). Only briefs are audited: a brief is a recoverable
demotion, so surfacing under-ranked briefs is the whole game. (The one
UNrecoverable move — dropping a non-duplicate — can't be audited from published
data, because a dropped story leaves no row; that guard lives at merge time in the
routine, against the source emails.)

Mirrors scan_arcs.py / scan_metrics.py: reads Supabase directly (always reachable,
even from an egress-blocked cloud sandbox), so it runs in every window.

Usage:  python3 scripts/scan_sort.py [<date> | --days N | --all]
        <date>   : audit a single day (YYYY-MM-DD)  — the routine's normal call
        --days N : audit the last N days (default 7)
        --all    : audit the entire archive

The five auto-card floor triggers it checks (any ONE makes a brief a mis-brief):
  1. Substantive New York   — market NY and not a routine small Sale/Lease closing
  2. Market-wide signal     — dealType Markets / Policy / (systemic) Distress
  3. Prominence subject      — a rostered player or marquee name in the TITLE
  4. Tracked arc            — the story carries a `thread` (an arc installment)
  5. Cited market series     — an attributed %/bps market figure in the summary
"""
import json, re, sys, urllib.request

# ---- Supabase creds (read from push_data.py, same as the other scanners) ----
_src = open(__file__.rsplit("/", 1)[0] + "/push_data.py").read()
URL = re.search(r"https://[a-z0-9]+\.supabase\.co", _src).group(0)
KEY = re.search(r"sb_publishable_[A-Za-z0-9_-]+", _src).group(0)
_H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
def _get(path):
    return json.load(urllib.request.urlopen(urllib.request.Request(f"{URL}/rest/v1/{path}", headers=_H)))

# ---- args ----
ONE_DATE = None
DAYS = 7
if "--all" in sys.argv:
    DAYS = 10_000
elif "--days" in sys.argv:
    DAYS = int(sys.argv[sys.argv.index("--days") + 1])
else:
    for a in sys.argv[1:]:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", a):
            ONE_DATE = a

# ---- trigger 3 vocabulary: a curated MARQUEE floor (not the full roster) ------
# Trigger 3 fires when a marquee name lands in the TITLE (titles name the subject;
# a bit-part broker/lender credit almost never reaches the headline). We use a
# curated marquee list, NOT the whole players roster, on purpose: roster
# membership is far too broad a proxy for "prominent" — every profiled brokerage,
# trade group, and small principal is rostered, so matching the roster flags
# routine items ("Miami Realtors expands into a county"). The marquee list is the
# household-name floor: high precision, so a flag is almost always a real miss.
MARQUEE = [
    "related", "vornado", "sl green", "brookfield", "blackstone", "tishman speyer",
    "extell", "silverstein", "rxr", "hines", "durst", "rudin", "fisher brothers",
    "witkoff", "macklowe", "zeckendorf", "ken griffin", "kenneth griffin",
    "boston properties", "starwood", "oaktree", "fortress capital",
    "trump organization", "kushner", "gary barnett", "steve roth", "marc holliday",
    "rob speyer", "stephen ross", "sl green realty", "vornado realty",
]
PAT = [(re.compile(r"\b" + re.escape(m) + r"\b", re.I), m.title()) for m in MARQUEE]

def subject_hit(title):
    hits = {lbl for rx, lbl in PAT if rx.search(title)}
    return sorted(hits)[0] if hits else None

# ---- trigger 2: a SYSTEMIC-signal marker (keeps trend-color out) --------------
# Markets/Policy dealType alone is NOT the floor — step 4's floor is a *systemic*
# read (a rate/credit signal, a distress-wave print, a sector-reshaping policy,
# major consolidation), NOT every National trend piece ("luxury second-home
# demand", "battery storage as an asset class" are legitimately briefs). So a
# Markets/Policy brief only trips the floor when its title+summary carries a
# systemic marker — otherwise it stays a brief.
SYSTEMIC = re.compile(
    r"\b(rate|rates|fed|federal reserve|basis point|bps|yield|treasury|sofr|"
    r"credit|lending|loan|loans|lender|debt|refinanc|maturit|default|delinquen|cmbs|clo|"
    r"distress|foreclos|bankrupt|chapter 11|receivership|workout|insolvenc|"
    r"vacanc|absorption|occupancy|"
    r"bond|tax|subsid|zoning|rent control|rent freeze|rent stabiliz|legislation|"
    r"bill|ballot|moratorium|ordinance|regulat|tariff|"
    r"merger|acqui|takeover|consolidat|"
    r"billion)\b", re.I)
def is_systemic(text, val):
    return bool(SYSTEMIC.search(text or "")) or (val is not None and val >= 500_000_000)

# ---- trigger 5: an attributed market figure (light version of scan_metrics) ---
# a %/bps figure near an attribution phrase — "per <Proper Noun>" / "<Proper
# Noun> reported|data|survey|index". Summary-only (content not needed here).
FIG = re.compile(r"\b\d+(?:\.\d+)?\s?(?:%|percent|bps|basis points)\b", re.I)
ATTR = re.compile(
    r"(?:per|according to|by|from)\s+[A-Z][A-Za-z.&]+"
    r"|[A-Z][A-Za-z.&]+(?:\s+[A-Z][A-Za-z.&]+)?\s+(?:reported|data|survey|index|found|says|said)\b")
def cites_series(summary):
    return bool(summary) and bool(FIG.search(summary)) and bool(ATTR.search(summary))

# ---- floor evaluation for ONE brief ------------------------------------------
def floor_triggers(s):
    """Return the list of floor triggers a BRIEF trips (empty = correctly briefed)."""
    hits = []
    market = (s.get("market") or "")
    deal = (s.get("dealType") or "")
    val = s.get("valueUsd")
    title = s.get("title") or ""
    summary = s.get("summary") or ""

    # 1 · Substantive New York — NY unless it's a routine small Sale/Lease closing
    if market == "New York":
        routine_closing = deal in ("Sale", "Lease") and (val is None or val < 50_000_000)
        if not routine_closing:
            hits.append("NY-substantive")

    # 2 · Market-wide signal — Markets/Policy ONLY when systemic (not trend color);
    #     Distress unless it's a tiny local one-off
    if deal in ("Markets", "Policy"):
        if is_systemic(f"{title}. {summary}", val):
            hits.append(f"market-signal:{deal}")
    elif deal == "Distress":
        tiny_local = val is not None and val < 25_000_000 and market not in ("National", "")
        if not tiny_local:
            hits.append("market-signal:Distress")

    # 3 · Prominence subject — a rostered/marquee name in the TITLE
    who = subject_hit(title)
    if who:
        hits.append(f"prominence:{who}")

    # 4 · Tracked arc — carries a thread
    if s.get("thread"):
        hits.append(f"arc:{s['thread']}")

    # 5 · Cited market series
    if cites_series(summary):
        hits.append("cited-series")

    return hits

# ---- load corpus & audit -----------------------------------------------------
if ONE_DATE:
    days = _get(f"days?date=eq.{ONE_DATE}&select=date,data")
else:
    days = _get("days?select=date,data&order=date.asc")
    if DAYS < 10_000:
        days = days[-DAYS:]

def fmt_val(v):
    if not v:
        return ""
    if v >= 1e9:  return f"${v/1e9:.1f}B"
    if v >= 1e6:  return f"${v/1e6:.0f}M"
    return f"${v:,.0f}"

total_briefs = total_flags = 0
for row in sorted(days, key=lambda r: r["date"]):
    date = row["date"]
    stories = row["data"].get("stories", [])
    briefs = [s for s in stories if s.get("brief")]
    total_briefs += len(briefs)
    flagged = [(s, floor_triggers(s)) for s in briefs]
    flagged = [(s, t) for s, t in flagged if t]
    if not flagged:
        continue
    ncards = sum(1 for s in stories if not s.get("brief"))
    print(f"\n━━ {date}  ({ncards} cards · {len(briefs)} briefs · {len(flagged)} mis-briefed) ━━")
    for s, trig in flagged:
        total_flags += 1
        meta = " · ".join(x for x in [s.get("market"), s.get("dealType"), fmt_val(s.get("valueUsd"))] if x)
        print(f"  ⤴ PROMOTE  {s['id']}")
        print(f"     {s.get('title','')}")
        print(f"     [{meta}]  →  trips: {', '.join(trig)}")

print(f"\n{'─'*60}")
if total_flags == 0:
    print(f"✓ SORT HELD — 0 floor-violating briefs across {len(days)} day(s), {total_briefs} briefs checked.")
else:
    print(f"⚠ {total_flags} mis-briefed stor{'y' if total_flags==1 else 'ies'} across {len(days)} day(s) "
          f"({total_briefs} briefs checked). Promote each to a card (drop `brief`), "
          f"or justify as a genuine near-dup of one already carded.")
