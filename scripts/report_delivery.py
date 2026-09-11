#!/usr/bin/env python3
"""Offline, aggregate-only publication timing report; see next-wave-delivery.md."""
import argparse
import json
import math
import statistics
import re
from urllib.parse import urlsplit
from pathlib import Path

from publication import timestamp
from content_quality import assess_content

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
    device = {stage: {'present': False, 'count': 0, 'seconds': 0} for stage in ('received', 'displayed')}
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
        for stage, values in device.items():
            count_key, sum_key = f'valid_{stage}_latency_count', f'{stage}_latency_sum_seconds'
            if count_key not in row and sum_key not in row:
                continue
            valid_device, elapsed_device = row.get(count_key), row.get(sum_key)
            if type(valid_device) is not int or valid_device < 0 or valid_device > total:
                raise ValueError('Invalid device observation denominator')
            if isinstance(elapsed_device, bool) or not isinstance(elapsed_device, (float, int)) or not math.isfinite(elapsed_device) or elapsed_device < 0 or (valid_device == 0 and elapsed_device != 0):
                raise ValueError('Device observation samples require a nonnegative explicit sum')
            values['present'] = True
            values['count'] += valid_device
            values['seconds'] += elapsed_device
        states[row['state']] = states.get(row['state'], 0) + total
        count += valid; seconds += elapsed
    total_jobs = sum(states.values())
    def device_metric(stage):
        values = device[stage]
        if not values['present']:
            return 'unmeasured'
        return {'denominator': total_jobs, 'sample_count': values['count'],
                'excluded_count': total_jobs - values['count'],
                'mean_seconds': values['seconds'] / values['count'] if values['count'] else None,
                'meaning': 'Job creation to server observation of service-worker acknowledgement, including callback network delay.'}
    return {'total': total_jobs, 'states': states,
            'provider_acceptance': {'denominator': states.get('sent', 0), 'sample_count': count,
                                    'excluded_count': states.get('sent', 0) - count,
                                    'mean_seconds': seconds / count if count else None},
            'device_receipt': device_metric('received'), 'device_displayed': device_metric('displayed')}


def mailbox_report(stories):
    """One sample per story from earliest verified Gmail receipt linked to its URL."""
    excluded = {'no_verified_receipt': 0, 'missing_timestamp': 0, 'malformed_timestamp': 0, 'backwards': 0}
    samples = []
    for story in stories:
        coverage = story.get('coverage')
        urls = [story.get('url')]
        if isinstance(coverage, list):
            urls.extend(row.get('url') for row in coverage if isinstance(row, dict))
        urls = {url for url in urls if isinstance(url, str)}
        receipts = story.get('sourceReceipts')
        verified = []
        for receipt in receipts if isinstance(receipts, list) else []:
            if not isinstance(receipt, dict) or receipt.get('provider') != 'gmail':
                continue
            proof, url = receipt.get('messageHash'), receipt.get('url')
            if not isinstance(proof, str) or not re.fullmatch(r'[a-f0-9]{64}', proof) or not isinstance(url, str) or url not in urls:
                continue
            try:
                parsed_url = urlsplit(url)
                if parsed_url.scheme not in ('http', 'https') or not parsed_url.hostname or parsed_url.username or parsed_url.password:
                    continue
            except ValueError:
                continue
            state, stamp = observed(receipt.get('receivedAt'))
            if state == 'valid':
                verified.append(stamp)
        if not verified:
            excluded['no_verified_receipt'] += 1
            continue
        state, first = observed(story.get('firstPublishedAt'))
        if state != 'valid':
            excluded[state + '_timestamp'] += 1
            continue
        elapsed = (first - min(verified)).total_seconds()
        if elapsed < 0:
            excluded['backwards'] += 1
        else:
            samples.append(elapsed)
    return {'denominator': len(stories), 'sample_count': len(samples), 'excluded': excluded,
            'min_seconds': min(samples) if samples else None,
            'median_seconds': statistics.median(samples) if samples else None,
            'max_seconds': max(samples) if samples else None}


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
              'current_content_ready': sum(assess_content(s.get('content'))['ready'] for s in stories),
              'summary_to_ready': {'denominator': len(stories), 'sample_count': len(latencies), 'excluded': excluded,
                                   'min_seconds': min(latencies) if latencies else None,
                                   'median_seconds': statistics.median(latencies) if latencies else None,
                                   'max_seconds': max(latencies) if latencies else None},
              'mailbox_receipt_to_first_published': mailbox_report(stories),
              'limitations': ['firstPublishedAt records new story publication only; existing stories are not backdated.',
                              'summaryPublishedAt is the latest observed title/summary publication, not first receipt.',
                              'Current readiness uses article-body quality checks; historical contentReadyAt can predate those checks and older content can predate its timestamp.',
                              'Mailbox samples require Gmail messageHash, a linked source URL and timezone-qualified receivedAt; raw receivedAt alone is excluded.',
                              'Device times are server observations including callback network delay; displayed means showNotification resolved, not human attention or reading.',
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
