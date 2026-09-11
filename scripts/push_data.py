#!/usr/bin/env python3
"""Upsert local data files into the Supabase backend that the hosted app reads.

Usage:
  python3 scripts/push_data.py --all-dates     # explicitly publish every local day/week
  python3 scripts/push_data.py --registries    # explicitly publish research registries
  python3 scripts/push_data.py 2026-07-14      # push one day (plus its week file if present)

The pipeline writes local JSON first (same schemas as before, documented in
CLAUDE.md), then runs this to publish. Uses the project's publishable key —
the tables have open-write RLS by owner's choice (single-user app).
"""
import json
import argparse
from datetime import date, timedelta, datetime
from zoneinfo import ZoneInfo
import publication
import pathlib
import sys
import urllib.request

SUPABASE_URL = "https://uhwdnmbxiopfysodydty.supabase.co"
ANON_KEY = "sb_publishable_LEQ5_-jjcRRl2p0wlaiXcw_RX4Wf8-y"

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def upsert(table: str, row: dict) -> None:
    doc = dict(row["data"])
    if table not in ("days", "weeks"):
        doc["generatedAt"] = row.get("updated_at")
    publication.publish_document(table, str(row[publication.KEYS[table]]), doc)


def push_day(path: pathlib.Path) -> None:
    doc = json.loads(path.read_text())
    upsert("days", {"date": doc["date"], "data": doc, "generated_at": doc.get("generatedAt")})
    print(f"pushed day  {doc['date']}")


def push_week(path: pathlib.Path) -> None:
    doc = json.loads(path.read_text())
    upsert("weeks", {"week_of": doc["weekOf"], "data": doc, "generated_at": doc.get("generatedAt")})
    print(f"pushed week {doc['weekOf']}")


def push_players(path: pathlib.Path) -> None:
    doc = json.loads(path.read_text())
    players = doc.get("players", {})
    for slug, entity in players.items():
        upsert("players", {"slug": slug, "data": entity, "updated_at": doc.get("generatedAt")})
    print(f"pushed {len(players)} players")


def push_terms(path: pathlib.Path) -> None:
    doc = json.loads(path.read_text())
    terms = doc.get("terms", {})
    for slug, entry in terms.items():
        upsert("terms", {"slug": slug, "data": entry, "updated_at": doc.get("generatedAt")})
    print(f"pushed {len(terms)} terms")


def push_keyed(path: pathlib.Path, table: str, doc_key: str, pk: str) -> None:
    """Registries stored as one local file of keyed entries, one Supabase row each
    (threads / events / metrics — same ride-along pattern as players and terms)."""
    doc = json.loads(path.read_text())
    entries = doc.get(doc_key, {})
    for key, entry in entries.items():
        upsert(table, {pk: key, "data": entry, "updated_at": doc.get("generatedAt")})
    print(f"pushed {len(entries)} {doc_key}")


def publication_paths(data, only=None, all_dates=False):
    if only:
        publication.validate_date(only)
        day_path = data / f"{only}.json"
        if not day_path.exists():
            raise FileNotFoundError(day_path)
        monday = date.fromisoformat(only)
        monday -= timedelta(days=monday.weekday())
        week = data / "weeks" / f"{monday.isoformat()}.json"
        return [day_path], [week] if week.exists() else []
    if all_dates:
        return sorted(data.glob("????-??-??.json")), sorted((data / "weeks").glob("????-??-??.json"))
    return [], []


def main() -> None:
    parser = argparse.ArgumentParser(description="Publish explicitly scoped briefing data")
    parser.add_argument("date", nargs="?", type=publication.validate_date)
    parser.add_argument("--all-dates", action="store_true", help="Explicitly publish all local day/week files")
    parser.add_argument("--registries", action="store_true", help="Explicitly publish local research registries")
    args = parser.parse_args()
    if args.date and args.all_dates:
        parser.error("Use a date or --all-dates, not both")
    legacy_default = not (args.date or args.all_dates or args.registries)
    if legacy_default:
        # Existing cloud routines invoke this without arguments. Keep that
        # contract, but never republish historical files lying in the workspace.
        args.date = datetime.now(ZoneInfo("America/New_York")).date().isoformat()
        args.registries = True
    days, weeks = publication_paths(DATA, args.date, args.all_dates)
    registries = [("players", "slug"), ("terms", "slug"), ("threads", "slug"),
                  ("campaigns", "slug"), ("events", "id"), ("metrics", "id")]
    if legacy_default:
        fresh = []
        for table, pk in registries:
            path = DATA / f"{table}.json"
            if not path.exists():
                continue
            doc = json.loads(path.read_text())
            generated = publication.timestamp(doc.get("generatedAt"))
            if generated.astimezone(ZoneInfo("America/New_York")).date().isoformat() == args.date:
                fresh.append((table, pk))
            else:
                print(f"skipped stale local registry {table}; use --registries explicitly if intended")
        registries = fresh
    # Validate the entire selected batch before its first remote mutation.
    for table, paths in (("days", days), ("weeks", weeks)):
        for path in paths:
            doc = json.loads(path.read_text())
            publication.validate_document(table, doc)
            if doc["date" if table == "days" else "weekOf"] != path.stem:
                raise ValueError("Filename/document date mismatch: " + str(path))
    if args.registries:
        for table, pk in registries:
            path = DATA / f"{table}.json"
            if not path.exists():
                continue
            doc = json.loads(path.read_text())
            publication.timestamp(doc.get("generatedAt"))
            entries = doc.get(table)
            if not isinstance(entries, dict):
                raise ValueError(table + " must be a keyed object")
            for key, entity in entries.items():
                if not key.strip():
                    raise ValueError("Empty registry key")
                publication.validate_document(table, entity)
    for path in days:
        push_day(path)
    for path in weeks:
        push_week(path)
    if args.registries:
        for table, pk in registries:
            path = DATA / f"{table}.json"
            if path.exists():
                push_keyed(path, table, table, pk)


if __name__ == "__main__":
    main()
