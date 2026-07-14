#!/usr/bin/env python3
"""Fetch the daily Treasury par yield curve and SOFR, publish to Supabase.

Usage: python3 scripts/fetch_rates.py
Writes data/rates.json and upserts the row into the `rates` table (keyed by the
curve date). Run by the daily pipeline; safe to re-run any time.

Sources:
- treasury.gov daily par yield curve XML feed (current month)
- NY Fed markets API: SOFR and 30/90/180-day SOFR averages
"""
import json
import pathlib
import re
import urllib.request
from datetime import datetime, timezone
from xml.etree import ElementTree

SUPABASE_URL = "https://uhwdnmbxiopfysodydty.supabase.co"
ANON_KEY = "sb_publishable_LEQ5_-jjcRRl2p0wlaiXcw_RX4Wf8-y"
ROOT = pathlib.Path(__file__).resolve().parent.parent

TENOR_FIELDS = [
    ("1M", "BC_1MONTH"), ("2M", "BC_2MONTH"), ("3M", "BC_3MONTH"),
    ("4M", "BC_4MONTH"), ("6M", "BC_6MONTH"), ("1Y", "BC_1YEAR"),
    ("2Y", "BC_2YEAR"), ("3Y", "BC_3YEAR"), ("5Y", "BC_5YEAR"),
    ("7Y", "BC_7YEAR"), ("10Y", "BC_10YEAR"), ("20Y", "BC_20YEAR"),
    ("30Y", "BC_30YEAR"),
]


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "briefing-rates/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def treasury_curve():
    year = datetime.now(timezone.utc).strftime("%Y")
    xml = get(
        "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml"
        f"?data=daily_treasury_yield_curve&field_tdr_date_value={year}"
    )
    root = ElementTree.fromstring(xml)
    ns_d = "{http://schemas.microsoft.com/ado/2007/08/dataservices}"
    entries = []
    for props in root.iter("{http://schemas.microsoft.com/ado/2007/08/dataservices/metadata}properties"):
        row = {}
        date_el = props.find(f"{ns_d}NEW_DATE")
        if date_el is None or not date_el.text:
            continue
        row["date"] = date_el.text[:10]
        for label, field in TENOR_FIELDS:
            el = props.find(f"{ns_d}{field}")
            if el is not None and el.text:
                try:
                    row[label] = float(el.text)
                except ValueError:
                    pass
        entries.append(row)
    entries.sort(key=lambda r: r["date"])
    return entries[-1] if entries else None


def nyfed(path):
    doc = json.loads(get(f"https://markets.newyorkfed.org/api/rates/secured/{path}/last/1.json"))
    rows = doc.get("refRates") or []
    return rows[0] if rows else {}


def main():
    curve = treasury_curve()
    sofr = nyfed("sofr")
    avgs = nyfed("sofrai")

    if not curve:
        raise SystemExit("no treasury curve data returned")

    doc = {
        "curveDate": curve["date"],
        "treasury": {k: v for k, v in curve.items() if k != "date"},
        "sofr": {
            "rate": sofr.get("percentRate"),
            "date": sofr.get("effectiveDate"),
        },
        "sofrAverages": {
            "30d": avgs.get("average30day"),
            "90d": avgs.get("average90day"),
            "180d": avgs.get("average180day"),
            "date": avgs.get("effectiveDate"),
        },
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    (ROOT / "data").mkdir(exist_ok=True)
    (ROOT / "data" / "rates.json").write_text(json.dumps(doc, indent=2))

    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/rates",
        data=json.dumps({"date": doc["curveDate"], "data": doc, "generated_at": doc["generatedAt"]}).encode(),
        headers={
            "apikey": ANON_KEY,
            "Authorization": f"Bearer {ANON_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        assert r.status in (200, 201)
    print(f"rates published for {doc['curveDate']}: "
          f"5Y {doc['treasury'].get('5Y')} · 10Y {doc['treasury'].get('10Y')} · "
          f"30Y {doc['treasury'].get('30Y')} · SOFR {doc['sofr']['rate']}")


if __name__ == "__main__":
    main()
