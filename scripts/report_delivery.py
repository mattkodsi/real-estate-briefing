#!/usr/bin/env python3
"""Offline, aggregate-only publication timing report; see next-wave-delivery.md."""
import argparse
import json
import math
import statistics
from pathlib import Path

from publication import content_words, timestamp

FIELDS = ('firstPublishedAt', 'summaryPublishedAt', 'contentReadyAt', 'enrichedAt', 'fillAttemptedAt')


def observed(value):
    if value is None:
        return 'missing', None
    try:
        return 'valid', timestamp(value)
    except (ValueError, TypeError, OverflowError):
        return 'malformed', None


def push_report(rows):
    if not isinstance(rows, list):
        raise ValueError('Job aggregates must be an array')
    states = {}; count = 0; seconds = 0
    for row in rows:
        if not isinstance(row, dict) or row.get('state') not in ('pending', 'sending', 'retry', 'sent', 'gone', 'failed'):
            raise ValueError('Invalid job state aggregate')
        total = row.get('count'); valid = row.get('valid_latency_count', 0)
        elapsed = row.get('latency_sum_seconds', 0)
        if any(type(n) is not int or n < 0 for n in (total, valid)) or valid > total:
            raise ValueError('Invalid job aggregate denominator')
        if isinstance(elapsed, bool) or not isinstance(elapsed, (float, int)) or not math.isfinite(elapsed) or elapsed < 0 or (valid == 0 and elapsed != 0):
            raise ValueError('Invalid job latency sum')
        if valid and 'latency_sum_seconds' not in row:
            raise ValueError('Observed latency samples require an explicit sum')
        if row['state'] != 'sent' and (valid or elapsed):
            raise ValueError('Only sent jobs measure provider acceptance')
        states[row['state']] = states.get(row['state'], 0) + total
        count += valid; seconds += elapsed
    return {'total': sum(states.values()), 'states': states,
            'provider_acceptance': {'denominator': states.get('sent', 0), 'sample_count': count,
                                    'excluded_count': states.get('sent', 0) - count,
                                    'mean_seconds': seconds / count if count else None},
            'device_receipt': 'unmeasured'}


def build_report(data, jobs=None):
    rows = data if isinstance(data, list) else [data]
    stories = []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('Expected day documents or exported rows with data')
        document = row.get('data', row)
        if not isinstance(document, dict) or not isinstance(document.get('stories'), list) or any(not isinstance(s, dict) for s in document['stories']):
            raise ValueError('Each day must contain a stories array of objects')
        stories.extend(document['stories'])
    coverage = {field: {'valid': 0, 'missing': 0, 'malformed': 0, 'denominator': len(stories)} for field in FIELDS}
    excluded = {'missing_timestamp': 0, 'malformed_timestamp': 0, 'backwards': 0}
    latencies = []
    for story in stories:
        parsed = {field: observed(story.get(field)) for field in FIELDS}
        for field, (state, _) in parsed.items():
            coverage[field][state] += 1
        start, end = parsed['summaryPublishedAt'], parsed['contentReadyAt']
        # Exclusive categories: a missing endpoint takes precedence over malformed.
        if 'missing' in (start[0], end[0]):
            excluded['missing_timestamp'] += 1
        elif 'malformed' in (start[0], end[0]):
            excluded['malformed_timestamp'] += 1
        else:
            elapsed = (end[1] - start[1]).total_seconds()
            if elapsed < 0:
                excluded['backwards'] += 1
            else:
                latencies.append(elapsed)
    result = {'days': len(rows), 'stories': len(stories), 'timestamps': coverage,
              'current_content_ready': sum(content_words(s.get('content')) >= 120 for s in stories),
              'summary_to_ready': {'denominator': len(stories), 'sample_count': len(latencies), 'excluded': excluded,
                                   'min_seconds': min(latencies) if latencies else None,
                                   'median_seconds': statistics.median(latencies) if latencies else None,
                                   'max_seconds': max(latencies) if latencies else None},
              'mailbox_receipt_to_summary': 'unmeasured: no verified receipt-to-story mapping',
              'limitations': ['firstPublishedAt records new story publication only; existing stories are not backdated.',
                              'summaryPublishedAt is the latest observed title/summary publication, not first receipt.',
                              'contentReadyAt records an observed transition to at least 120 words; older content can predate it.',
                              'Backwards pairs can follow editorial revisions; they are excluded, not repaired.',
                              'Current snapshots do not establish uninterrupted content availability or device receipt.']}
    if jobs is not None:
        result['push_jobs'] = push_report(jobs)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('days', type=Path, help='Local JSON day document or array of documents / {data: document} rows')
    parser.add_argument('--jobs', type=Path, help='Local array of safe job aggregates (schema in delivery documentation)')
    args = parser.parse_args()
    try:
        result = build_report(json.loads(args.days.read_text()), json.loads(args.jobs.read_text()) if args.jobs else None)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
