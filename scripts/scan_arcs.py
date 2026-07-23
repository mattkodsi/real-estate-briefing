#!/usr/bin/env python3
"""
scan_arcs.py — deterministic surfacer for MISSING tales (story threads).

The daily routine keeps under-creating tales because "notice that two stories
share a concrete anchor and link them" is a judgment call it skips. This script
removes the judgment: it mechanically scans a window of recent days for story
PAIRS that share a concrete anchor and prints them as candidate tales for the
routine to register (or reject with a reason). It is a FLOOR, not a ceiling:
high recall on the concrete anchors, precision left to the routine.

Mirrors scan_metrics.py: reads Supabase directly (always reachable, even from an
egress-blocked cloud sandbox), so it runs in every window.

Usage:  python3 scripts/scan_arcs.py [--days N] [--all]
        --days N : scan the last N days (default 10)
        --all    : scan the entire archive

Anchors it detects (any ONE promotes a pair to a candidate):
  • near-identical headline  — a story re-reported the next day (highest value)
  • same street address      — 105 Willis Ave in two stories
  • shared RARE roster actor — a person/company that appears in only ~2 stories
                               (Peter Fine, Ken Griffin, RealPage, Boxabl)
  • shared uncommon actor + corroboration ($ figure / same pin / similar title)
Entities come from the curated PLAYERS ROSTER (people + companies + aliases), so
neighborhoods, states and common words are never mistaken for anchors. A shared
$ figure or a common firm (Brookfield in a dozen deals) never anchors alone —
prices and big names coincide constantly.

Pairs already linked into the SAME registered thread are shown as ✓ (confirmation
the routine did its job); a run with only ✓ rows means nothing was missed.
"""
import json, re, sys, urllib.request
from itertools import combinations
from difflib import SequenceMatcher
from collections import Counter

# ---- Supabase creds (read from push_data.py, same as the other scripts) ----
_src = open(__file__.rsplit("/", 1)[0] + "/push_data.py").read()
URL = re.search(r"https://[a-z0-9]+\.supabase\.co", _src).group(0)
KEY = re.search(r"sb_publishable_[A-Za-z0-9_-]+", _src).group(0)
_H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
def _get(path):
    return json.load(urllib.request.urlopen(urllib.request.Request(f"{URL}/rest/v1/{path}", headers=_H)))

# ---- args ----
DAYS = 10
if "--all" in sys.argv:
    DAYS = 10_000
elif "--days" in sys.argv:
    DAYS = int(sys.argv[sys.argv.index("--days") + 1])

# ---- entity vocabulary from the curated players roster ----
# each player contributes match patterns: its display name, its aliases, and (for
# people with a distinctive multi-part name) the bare surname — mirroring how the
# app auto-links. Common English words are never used as a lone pattern.
_STOPNAME = set("""the group company companies capital partners holdings realty trust properties
development corp inc llc management advisors ventures fund estate real""".split())
def _patterns(slug, d):
    pats = set()
    nm = (d.get("name") or "").strip()
    if nm:
        pats.add(nm.lower())
    for a in (d.get("aliases") or []):
        if a and len(a) >= 3:
            pats.add(a.lower())
    if d.get("type") == "person":
        parts = [p for p in re.findall(r"[A-Za-z'’-]+", nm) if len(p) > 2]
        if len(parts) >= 2 and parts[-1].lower() not in _STOPNAME:
            pats.add(parts[-1].lower())  # bare surname
    return {p for p in pats if len(p) >= 4 and p not in _STOPNAME}

players = _get("players?select=slug,data")
PAT = []  # (slug, compiled-regex)
for p in players:
    if p["slug"].startswith("_"):
        continue
    for pat in _patterns(p["slug"], p["data"]):
        PAT.append((p["slug"], re.compile(r"\b" + re.escape(pat) + r"\b", re.I)))

def actors(text):
    return {slug for slug, rx in PAT if rx.search(text)}

# ---- other concrete anchors ----
STOP = set("""the a an of in on for to and or at by with from as is are be into over under after
before amid new near its his her their our your out off up down more most less than that this
these those it he she they we you has have had will would can could may plans eyes seeks snags
lands faces file files signs debuts goes begins adds sees set sets vs per""".split())
ADDR = re.compile(
    r"\b\d{1,4}\s+(?:[A-Z][A-Za-z.'-]+\s+){0,3}"
    r"(?:Ave|Avenue|St|Street|Rd|Road|Blvd|Boulevard|Dr|Drive|Pl|Place|Sq|Square|"
    r"Lane|Ln|Way|Pkwy|Parkway|Terrace|Ter|Ct|Court|Broadway|Plaza)\b")
MONEY = re.compile(r"\$\s?\d[\d.,]*\s?(?:b|bn|m|mm|k|billion|million|thousand)\b", re.I)

def title_tokens(t):
    return {w for w in re.findall(r"[a-z0-9$]+", t.lower()) if w not in STOP and len(w) > 2}
def money_set(text):
    out = set()
    for m in MONEY.finditer(text):
        s = re.sub(r"\s", "", m.group().lower()).rstrip(".,")
        s = (s.replace("billion","b").replace("million","m").replace("thousand","k")
               .replace("bn","b").replace("mm","m"))
        out.add(s)
    return out
def addr_set(text):
    return {re.sub(r"\s+", " ", a).lower().rstrip(".") for a in ADDR.findall(text)}
def loc_key(s):
    return [(round(l["lat"], 2), round(l["lng"], 2)) for l in (s.get("locations") or []) if l.get("lat") is not None]

# ---- load corpus ----
days = _get("days?select=date,data&order=date.asc")
if DAYS < 10_000:
    days = days[-DAYS:]
threads = _get("threads?select=slug,data")
story_thread = {}
for t in threads:
    if t["data"].get("retracted"):
        continue   # a retracted tale's stories should re-surface (as dupes), not read as linked
    for e in t["data"].get("entries", []):
        story_thread[e["id"]] = t["slug"]

S = []
for row in days:
    d = row["date"]
    for s in row["data"].get("stories", []):
        text = f"{s.get('title','')}. {s.get('summary','')}"
        S.append({
            "date": d, "id": s["id"], "title": s.get("title", ""),
            "market": s.get("market"), "thread": s.get("thread"),
            "ttok": title_tokens(s.get("title", "")),
            "actors": actors(text), "money": money_set(text),
            "addr": addr_set(text), "loc": loc_key(s),
        })

# document-frequency of each actor across the window: an actor in ~2 stories is a
# real anchor; one in a dozen (Brookfield) is generic and can't anchor alone.
df = Counter()
for s in S:
    for a in s["actors"]:
        df[a] += 1
def tier(slug):
    d = df[slug]
    return "rare" if d <= 2 else ("mid" if d <= 5 else "common")
name_of = {p["slug"]: (p["data"].get("name") or p["slug"]) for p in players}

def loc_close(a, b):
    return any(abs(x[0]-y[0]) <= 0.02 and abs(x[1]-y[1]) <= 0.02 for x in a for y in b)

# ---- score every cross-story pair ----
cands = []
for a, b in combinations(S, 2):
    shared = a["actors"] & b["actors"]
    rare = sorted((s for s in shared if tier(s) == "rare"), key=lambda s: name_of[s])
    mid = sorted((s for s in shared if tier(s) == "mid"), key=lambda s: name_of[s])
    shared_addr = a["addr"] & b["addr"]
    shared_money = a["money"] & b["money"]
    jac = (len(a["ttok"] & b["ttok"]) / len(a["ttok"] | b["ttok"])) if (a["ttok"] | b["ttok"]) else 0
    tsim = SequenceMatcher(None, a["title"].lower(), b["title"].lower()).ratio()
    hi = max(jac, tsim)
    close = loc_close(a["loc"], b["loc"])
    # concrete anchor the two stories share (for BOTH the dupe and tale buckets)
    anchor = []
    if shared_addr: anchor.append(("address", ", ".join(sorted(shared_addr))))
    if rare: anchor.append(("rare actor", ", ".join(name_of[s] for s in rare)))
    elif len(mid) >= 2: anchor.append(("2+ actors", ", ".join(name_of[s] for s in mid)))
    # a single mid-frequency actor alone is almost always unrelated deals — surface
    # only when a $ figure or shared pin corroborates it
    elif len(mid) == 1 and (shared_money or close): anchor.append(("actor+corrob", name_of[mid[0]]))
    extra = (["$" + ",".join(sorted(shared_money))] if shared_money else []) + (["same pin"] if close else [])
    same = story_thread.get(a["id"]) and story_thread.get(a["id"]) == story_thread.get(b["id"])
    existing = story_thread.get(a["id"]) or story_thread.get(b["id"])
    rec = {"a": a, "b": b, "anchor": anchor, "extra": extra, "hi": hi,
           "linked": same, "existing": existing}

    # A) DUPLICATE — a near-identical headline means it's the SAME story re-reported
    # (or the same event from a 2nd outlet). This is NOT a tale: a tale needs
    # DIFFERENT developments. It must be MERGED/deduped, never threaded. Require
    # some shared specificity so boilerplate templates aren't flagged.
    if hi >= 0.9 or (hi >= 0.72 and (shared or shared_addr or shared_money)):
        rec["kind"] = "dupe"; cands.append(rec); continue
    # B) TALE CANDIDATE — a shared concrete anchor with a DIFFERENT headline (a
    # possible new development). The routine must still judge: distinct
    # developments = tale; same actor + unrelated deals = skip.
    if anchor and hi < 0.72:
        rec["kind"] = "tale"
        rec["strong"] = bool(shared_addr) or len(mid) >= 2 or (bool(rare) and (shared_money or shared_addr))
        cands.append(rec)

dupes = [c for c in cands if c["kind"] == "dupe" and not c["linked"]]
strong = [c for c in cands if c["kind"] == "tale" and not c["linked"] and c["strong"]]
review = [c for c in cands if c["kind"] == "tale" and not c["linked"] and not c["strong"]]
linked = [c for c in cands if c["linked"]]
dupes.sort(key=lambda c: -c["hi"])

def show(c):
    sig = "; ".join(f"{k}: {v}" for k, v in c["anchor"]) or "—"
    if "hi" in c and c["kind"] == "dupe": sig = f"headline {c['hi']:.2f} identical; " + sig
    if c["extra"]: sig += "  (+ " + ", ".join(c["extra"]) + ")"
    note = f"   ↳ one side already in '{c['existing']}'" if c["existing"] else ""
    print(f"● {sig}{note}")
    print(f"    {c['a']['date']} · {c['a']['id']}  \"{c['a']['title'][:72]}\"")
    print(f"    {c['b']['date']} · {c['b']['id']}  \"{c['b']['title'][:72]}\"")

# ---- report ----
print(f"scan_arcs — window: last {'ALL' if DAYS >= 10000 else DAYS} days "
      f"({len(S)} stories, {len(threads)} registered tales, {len(PAT)} actor patterns)\n")
print(f"⚠ LIKELY DUPLICATES — same story re-reported / same event from a 2nd outlet.")
print(f"  MERGE the coverage into one story; do NOT thread these. ({len(dupes)}):\n")
for c in dupes:
    show(c)
print(f"\n■ TALE CANDIDATES — shared anchor + DIFFERENT headline (a possible NEW development).")
print(f"  Register ONLY if it's a genuine progression, not a restatement. ({len(strong)}):\n")
for c in strong:
    show(c)
print(f"\n□ REVIEW — same actor, likely UNRELATED deals (usually NOT a tale) ({len(review)}):\n")
for c in review:
    show(c)
print(f"\n✓ ALREADY LINKED (registered tales, no action): {len(linked)} pair(s)")
for c in linked[:50]:
    print(f"    [{c['existing']}] {c['a']['id']}  +  {c['b']['id']}")
if not dupes and not strong and not review:
    print("\nNothing surfaced in the window.")
