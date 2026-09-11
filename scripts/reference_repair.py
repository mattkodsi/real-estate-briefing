#!/usr/bin/env python3
"""Evidence-reviewed reference repairs. Offline and dry-run by default; never publishes.

Manifest operations compare the complete previous value, and retarget operations
also compare the target's id/title/url. Output is suitable for a separate server
CAS publisher. Never use this utility's output as an unconditional upsert.
"""
import argparse
from copy import deepcopy
import json
from pathlib import Path
import re


def reference_containers(table, entry):
    if table in ('players', 'terms'):
        return [('mentions', entry.get('mentions', []))]
    if table == 'threads':
        return [('entries', entry.get('entries', []))]
    if table == 'campaigns':
        return [(f'branches[{i}].stories', b.get('stories', [])) for i, b in enumerate(entry.get('branches', [])) if isinstance(b, dict)]
    return []


def reviewed_unavailable(ref):
    """A marker is valid only when its original provenance still matches the ref."""
    if not isinstance(ref, dict):
        return False
    review = ref.get('referenceReview')
    return (isinstance(review, dict) and review.get('status') == 'unavailable'
            and bool(review.get('reviewedAt')) and bool(review.get('evidence'))
            and isinstance(review.get('original'), dict)
            and review['original'] == {k: v for k, v in ref.items() if k != 'referenceReview'})


def validate_registry_references(table, entry, days):
    """Return blockers for ALL refs. days maps dates to documents (None=unavailable).

    Callers must fetch every referenced date, fail closed on fetch failure, and
    overlay pending day documents before checking. Reviewed historical unavailable
    refs are allowed, but returned separately by the inventory report.
    """
    errors = []
    for field, refs in reference_containers(table, entry):
        if not isinstance(refs, list):
            errors.append({'location': field, 'reason': 'invalid_reference_list'})
            continue
        for i, ref in enumerate(refs):
            location = f'{field}[{i}]'
            if reviewed_unavailable(ref):
                continue
            if not isinstance(ref, dict) or not isinstance(ref.get('date'), str) or not isinstance(ref.get('id'), str) or not ref['id']:
                errors.append({'location': location, 'reason': 'invalid_reference'})
                continue
            day = days.get(ref['date'])
            if not isinstance(day, dict):
                errors.append({'location': location, 'reason': 'day_unavailable'})
            elif not any(s.get('id') == ref['id'] for s in day.get('stories', []) if isinstance(s, dict)):
                errors.append({'location': location, 'reason': 'story_absent'})
    return errors


def validate_known_identity_conflicts(story):
    """Narrow observed-confusion guard, not a general factual accuracy claim."""
    body = re.sub(r'<[^>]+>', ' ', story.get('content') or '')
    display = ' '.join(str(story.get(k) or '') for k in ('title', 'summary'))
    if re.search(r'\bMF1\b', body, re.I) and 'berkshire residential investments' in body.lower() and re.search(r'berkshire hathaway|warren buffett', display, re.I):
        return [{'reason': 'mf1_berkshire_identity_conflict', 'evidence': 'Reader body names Berkshire Residential Investments; display attributes MF1 transaction to Hathaway/Buffett.'}]
    return []


def at_path(value, path):
    parts = re.findall(r'[^.\[\]]+', path)
    for part in parts[:-1]:
        value = value[int(part)] if isinstance(value, list) else value[part]
    return value, int(parts[-1]) if isinstance(value, list) else parts[-1]


def apply_manifest(registries, days, manifest):
    """Pure in-memory CAS: validates everything before returning changed records."""
    result = deepcopy(registries)
    for op in manifest['operations']:
        entry = result[op['table']][op['key']]
        container, key = at_path(entry, op['location'])
        if (op.get('oldExists', True) and (key not in container if isinstance(container, dict) else key >= len(container))) or (not op.get('oldExists', True) and key in container) or (op.get('oldExists', True) and container[key] != op['old']):
            raise ValueError(f"stale repair: {op['table']}/{op['key']}/{op['location']}")
        if op.get('target'):
            target = op['target']; day = days.get(target['date'], {})
            found = [s for s in day.get('stories', []) if s.get('id') == target['id']]
            if len(found) != 1 or any(found[0].get(k) != v for k, v in target.items() if k != 'date'):
                raise ValueError('target changed or absent')
            if op['new'].get('date') != target['date'] or op['new'].get('id') != target['id']:
                raise ValueError('replacement does not match verified target')
        elif op.get('kind') == 'reference' and not reviewed_unavailable(op['new']):
            raise ValueError('unverified replacement reference')
        container[key] = deepcopy(op['new'])
    return result


def main():
    from report_research_quality import TABLES, registry_entries
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('export_dir', type=Path); p.add_argument('manifest', type=Path)
    p.add_argument('--output', type=Path, help='Write repaired local registry exports (no network)')
    a = p.parse_args()
    days = {d['date']: d for row in json.loads((a.export_dir/'days.json').read_text()) for d in [row.get('data', row)]}
    registries = {t: registry_entries(json.loads((a.export_dir/f'{t}.json').read_text()), t) for t in TABLES}
    manifest = json.loads(a.manifest.read_text())
    result = apply_manifest(registries, days, manifest)
    changed = {t: {k: v for k, v in values.items() if v != registries[t][k]} for t, values in result.items()}
    print(json.dumps({'dryRun': not bool(a.output), 'operationCount': len(manifest['operations']), 'changedRecords': {t: len(v) for t,v in changed.items()}}))
    if a.output:
        a.output.mkdir(parents=True, exist_ok=True)
        for t, values in changed.items():
            if values: (a.output/f'{t}.json').write_text(json.dumps(values, indent=2)+'\n')

if __name__ == '__main__': main()
