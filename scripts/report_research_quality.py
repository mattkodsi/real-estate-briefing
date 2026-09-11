#!/usr/bin/env python3
"""Offline research inventory; never reads network, publishes, merges or modifies inputs.

Input directory: days.json containing exported PostgREST rows or daily documents;
registry files contain exported rows, keyed entries, or {table: keyed entries}.
Output includes record keys and locations, never source prose or article URLs.
Missing export days are unresolved evidence, not proven broken references.
"""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import re
import unicodedata
from check_quality import check_document
from reference_repair import reviewed_unavailable

TABLES = ('players', 'terms', 'threads', 'campaigns', 'events', 'metrics')


def normalize(value):
    return re.sub(r'[^\w]+', ' ', unicodedata.normalize('NFKC', value).casefold()).strip()


def registry_entries(raw, table):
    if isinstance(raw, list):
        return {str(row.get('slug', row.get('id'))): row['data'] for row in raw}
    return raw.get(table, raw)


def build_report(days, registries):
    days = [row.get('data', row) for row in days]
    registries = {name: {key: value for key, value in registry_entries(raw, name).items()
                         if not key.startswith('_')} for name, raw in registries.items()}
    day_ids = {day['date']: {s.get('id') for s in day.get('stories', []) if isinstance(s, dict)} for day in days}
    candidates, refs, repeated, registry_refs, findings = [], [], [], [], []
    resolved_aliases = []
    reviewed_refs, reviewed_identities, relationships = [], [], []
    terms = registries.get('terms', {})
    for key, entry in terms.items():
        if not isinstance(entry, dict) or not entry.get('aliasOf'):
            continue
        path, target, reason = [key], entry['aliasOf'], None
        while True:
            if not isinstance(target, str):
                reason, target = 'invalid_alias_target', None
                break
            if target in path:
                reason = 'alias_cycle'
                break
            if target not in terms:
                reason = 'target_absent'
                break
            path.append(target)
            target_entry = terms[target]
            if not isinstance(target_entry, dict):
                reason = 'invalid_alias_target'
                break
            if not target_entry.get('aliasOf'):
                if len(path) == 2:
                    resolved_aliases.append(dict(table='terms', key=key, target_key=target))
                else:
                    # Current reader redirects once; a chain is not a resolved route.
                    reason = 'alias_chain'
                break
            target = target_entry['aliasOf']
        if reason:
            registry_refs.append(dict(table='terms', key=key, location='aliasOf',
                                      target_table='terms', target_key=target, reason=reason))
    resolved_keys = {a['key'] for a in resolved_aliases}
    reference_counts = Counter()
    for table in TABLES:
        entries = registries.get(table, {})
        names = defaultdict(set)
        for key, entry in entries.items():
            if not isinstance(entry, dict):
                continue
            primary = entry.get('name' if table == 'players' else 'term' if table == 'terms' else 'title')
            aliases = entry.get('aliases', [])
            if table in ('players', 'terms', 'threads', 'campaigns') and not (table == 'terms' and key in resolved_keys):
                for value in [primary, *(aliases if isinstance(aliases, list) else [])]:
                    if isinstance(value, str) and normalize(value):
                        names[normalize(value)].add(key)
            seen = Counter()
            containers = [('mentions', entry.get('mentions', []))] if table in ('players', 'terms') else [('entries', entry.get('entries', []))] if table == 'threads' else []
            if table == 'campaigns':
                containers = [(f'branches[{i}].stories', branch.get('stories', [])) for i, branch in enumerate(entry.get('branches', [])) if isinstance(branch, dict)]
                for target in entry.get('relatedThreads', []):
                    if isinstance(target, str) and target not in registries.get('threads', {}):
                        registry_refs.append(dict(table=table, key=key, target_table='threads', target_key=target, reason='target_absent' if 'threads' in registries else 'registry_not_exported'))
            for field, values in containers:
                if not isinstance(values, list):
                    refs.append(dict(table=table, key=key, location=field, reason='invalid_reference_list'))
                    continue
                for i, ref in enumerate(values):
                    reference_counts[table] += 1
                    date, identity = (ref.get('date'), ref.get('id')) if isinstance(ref, dict) else (None, None)
                    reason = None
                    if not isinstance(date, str) or not isinstance(identity, str) or not date or not identity:
                        reason = 'invalid_reference'
                    else:
                        seen[(date, identity)] += 1
                        if date not in day_ids:
                            reason = 'day_not_exported'
                        elif identity not in day_ids[date]:
                            reason = 'story_absent'
                    if reason and reviewed_unavailable(ref):
                        reviewed_refs.append(dict(table=table, key=key, location=f'{field}[{i}]', date=date, story_id=identity, reason=reason, review=ref['referenceReview']))
                        reason = None
                    if reason:
                        refs.append(dict(table=table, key=key, location=f'{field}[{i}]', date=date if isinstance(date, str) else None, story_id=identity if isinstance(identity, str) else None, reason=reason))
            repeated.extend(dict(table=table, key=key, date=date, story_id=identity, count=count)
                            for (date, identity), count in seen.items() if count > 1)
        candidates.extend(dict(table=table, keys=sorted(keys), status='candidate_only', match='exact_normalized_name_or_alias')
                          for _, keys in sorted(names.items()) if len(keys) > 1)
    # Registry findings run once, not once per day.
    active_registries = {**registries, 'terms': {k: v for k, v in registries.get('terms', {}).items() if k not in resolved_keys}}
    findings.extend(dict(scope='registries', **f) for f in check_document({'stories': []}, active_registries))
    for day in days:
        findings.extend(dict(scope=day['date'], **f) for f in check_document(day))
        for i, story in enumerate(day.get('stories', [])):
            if not isinstance(story, dict):
                continue
            target = story.get('thread')
            if isinstance(target, str) and target not in registries.get('threads', {}):
                registry_refs.append(dict(table='days', key=day['date'], location=f'stories[{i}]', target_table='threads', target_key=target, reason='target_absent' if 'threads' in registries else 'registry_not_exported'))
    # A pair sharing both a primary name and alias is still one candidate group.
    candidates = list({(c['table'], tuple(c['keys'])): c for c in candidates}.values())
    pending = []
    for candidate in candidates:
        table, keys = candidate['table'], candidate['keys']
        entries = registries[table]
        types = {entries[k].get('type') for k in keys} if table == 'players' else set()
        reviews = [review for k in keys for review in entries[k].get('researchReviews', [])
                   if isinstance(review, dict) and sorted(review.get('keys', [])) == keys
                   and review.get('decision') in ('same_entity', 'distinct_related')
                   and review.get('evidence') and review.get('reviewedAt')]
        if reviews:
            reviewed_identities.append({**candidate, 'status': 'reviewed', 'review': reviews[0]})
        elif len(types) > 1 and None not in types:
            relationships.append({**candidate, 'status': 'related_identity_types', 'types': sorted(types)})
        else:
            pending.append(candidate)
    # Reviewed relationships remain visible even after misleading aliases are removed.
    recorded = {(c['table'], tuple(c['keys'])) for c in reviewed_identities}
    for table, entries in registries.items():
        for entry in entries.values():
            if not isinstance(entry, dict):
                continue
            for review in entry.get('researchReviews', []):
                if not isinstance(review, dict) or review.get('decision') not in ('same_entity', 'distinct_related') or not review.get('evidence') or not review.get('reviewedAt'):
                    continue
                keys = review.get('keys', [])
                if not isinstance(keys, list) or len(keys) < 2 or not all(isinstance(k, str) and k in entries for k in keys):
                    continue
                sig = (table, tuple(sorted(keys)))
                if sig not in recorded:
                    reviewed_identities.append(dict(table=table, keys=sorted(keys), status='reviewed', review=review))
                    recorded.add(sig)
    candidates = pending
    return dict(day_count=len(days), story_count=sum(len(d.get('stories', [])) for d in days),
                date_range=[min(day_ids), max(day_ids)] if day_ids else [],
                registry_counts={name: len(entries) for name, entries in registries.items()},
                duplicate_candidates=candidates, reviewed_identity_decisions=reviewed_identities, identity_relationships=relationships, reviewed_unavailable_references=reviewed_refs, reference_issue_counts={"unreviewed": len(refs), "reviewed_unavailable": len(reviewed_refs), "total_unresolved": len(refs) + len(reviewed_refs)}, resolved_aliases=resolved_aliases, reference_counts=dict(reference_counts),
                reference_findings=refs, repeated_references=repeated, registry_reference_findings=registry_refs,
                quality_counts=dict(sorted(Counter(f['code'] for f in findings).items())), quality_findings=findings)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('export_dir', type=Path)
    args = parser.parse_args(argv)
    try:
        days = json.loads((args.export_dir / 'days.json').read_text())
        registries = {name: json.loads((args.export_dir / (name + '.json')).read_text()) for name in TABLES
                      if (args.export_dir / (name + '.json')).exists()}
        report = build_report(days, registries)
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        parser.exit(2, 'Could not read valid local exports. No files changed.\n')
    print(json.dumps(report, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
