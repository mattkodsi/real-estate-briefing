#!/usr/bin/env python3
"""Read-only, offline editorial structure checks. Never publishes or rewrites inputs.

python3 scripts/check_quality.py 2026-09-11 --registry-dir data
python3 scripts/check_quality.py /path/to/day.json --json
Exit 0: no structural errors (warnings may remain); 1: errors; 2: unreadable input.
This checks fields and conservative patterns, not factual truth or semantic quality.
"""
import argparse
import json
import math
import re
from pathlib import Path
from urllib.parse import urlparse

VALUE_TYPES = {'salePrice', 'askingPrice', 'loanAmount', 'debtBalance', 'developmentCost',
               'portfolioValue', 'assessedValue', 'enterpriseValue', 'other'}
STATUSES = {'closed', 'listed', 'pending', 'announced', 'proposed', 'unknown'}


def http_url(value):
    if not isinstance(value, str):
        return False
    try:
        parsed = urlparse(value)
        return parsed.scheme in ('http', 'https') and bool(parsed.hostname) and not parsed.username and not parsed.password
    except ValueError:
        return False


def finite_number(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def check_document(document, registries=None):
    """Return constant-message findings without quoting article bodies or titles."""
    findings = []

    def flag(code, location, message, severity='warning'):
        findings.append(dict(code=code, location=location, message=message, severity=severity))

    if not isinstance(document, dict) or not isinstance(document.get('stories'), list):
        flag('document_shape', 'document', 'Expected a daily object with a stories array.', 'error')
        return findings
    stories = document['stories']
    seen_brief = False
    cards = 0
    featured = []
    ids = set()
    nonfeatured_card_seen = False
    for index, story in enumerate(stories):
        location = f'stories[{index}]'
        if not isinstance(story, dict):
            flag('story_shape', location, 'Expected a story object.', 'error')
            continue
        identity = story.get('id')
        if not isinstance(identity, str) or not identity:
            flag('story_identity', location, 'Story id must be a nonempty string.', 'error')
        elif identity in ids:
            flag('duplicate_story_id', location, 'Story id is duplicated in this edition.', 'error')
        else:
            ids.add(identity)
        for field in ('brief', 'featured'):
            if field in story and not isinstance(story[field], bool):
                flag('story_boolean', location+'.'+field, 'Classification flag must be a boolean.', 'error')
        brief, top = story.get('brief') is True, story.get('featured') is True
        if brief:
            seen_brief = True
        else:
            cards += 1
            if seen_brief:
                flag('card_after_brief', location, 'A card follows a brief; the array must place ranked cards first.', 'error')
            if not top:
                nonfeatured_card_seen = True
        if top:
            featured.append(identity)
            if brief:
                flag('featured_brief', location, 'A featured story cannot be a brief.', 'error')
            if nonfeatured_card_seen:
                flag('featured_order', location, 'A featured story follows an unfeatured card; review the top ranking.')
        value = story.get('valueUsd')
        if value is not None:
            if not finite_number(value) or value <= 0:
                flag('amount_number', location, 'valueUsd must be a positive finite number, not a boolean.', 'error')
            if not story.get('valueType'):
                flag('amount_type_missing', location, 'Identify what the amount measures before using it as a comparable.')
            elif not isinstance(story['valueType'], str) or story['valueType'] not in VALUE_TYPES:
                flag('amount_type_invalid', location, 'valueType is not a supported explicit amount classification.', 'error')
            if not story.get('transactionStatus'):
                flag('transaction_status_missing', location, 'Record closed, listed, pending, announced, proposed or unknown status.')
            elif not isinstance(story['transactionStatus'], str) or story['transactionStatus'] not in STATUSES:
                flag('transaction_status_invalid', location, 'transactionStatus is not a supported status.', 'error')
            if story.get('valueType') == 'salePrice' and story.get('transactionStatus') == 'listed':
                flag('sale_status_mismatch', location, 'A listed amount is an asking price, not a closed sale price.', 'error')
            if not isinstance(story.get('transactionId'), str) or not story['transactionId'].strip():
                flag('transaction_identity_missing', location, 'Add a source-grounded stable transactionId to deduplicate transaction coverage.')
        # Deliberately narrow cue: presence of a real actor cannot be established by regex.
        prose = ' '.join(str(story.get(field) or '') for field in ('title', 'summary'))
        if re.search(r'\b(?:investors?|buyers?|lenders?|developers?|a\s+(?:firm|company))\s+(?:take[sn]?\s+over|took\s+over|seize[sd]?|acquire[sd]?)\b', prose, re.I):
            flag('actor_identification', location, 'Generic takeover wording: review whether the principal actor is named and briefly identified.')
        eligible = story.get('pushEligible')
        if 'pushEligible' in story and not isinstance(eligible, bool):
            flag('push_boolean', location, 'pushEligible must be true or false.', 'error')
        if 'pushEligible' not in story and story.get('cadence') == 'special':
            flag('push_eligibility_missing', location, 'Classify urgency explicitly; special cadence alone does not establish breaking news.')
        if eligible is True:
            for field, bound in (('pushTitle', 38), ('pushBody', 130)):
                text = story.get(field)
                if not isinstance(text, str) or not text.strip():
                    flag('push_copy_missing', location+'.'+field, 'Eligible alerts require complete headline and body microcopy.', 'error')
                    continue
                clean = ' '.join(text.split())
                if len(clean) > bound:
                    flag('push_title_length' if field == 'pushTitle' else 'push_body_length', location+'.'+field,
                         f'Notification field exceeds {bound} Unicode codepoints.', 'error')
                if re.search(r'(?:\.\.\.|…|\b(?:and|or|the|a|an|of|with|for|to))\s*[.,:;—-]*$', clean, re.I):
                    flag('push_body_fragment' if field == 'pushBody' else 'push_title_fragment', location+'.'+field,
                         'Microcopy may end mid-thought; write a complete message.')
    if cards > 30:
        flag('card_capacity', 'stories', 'More than 30 full cards exceed the fixed leaderboard capacity.', 'error')
    if cards and not featured:
        flag('featured_missing', 'stories', 'No featured stories are marked; review the leading stories.')
    if len(featured) > 5:
        flag('featured_capacity', 'stories', 'More than five featured stories weaken the top-story hierarchy.')
    points = document.get('keyPoints', [])
    if not isinstance(points, list):
        flag('keypoint_shape', 'keyPoints', 'Expected an array of takeaways.', 'error')
        points = []
    point_ids = []
    for index, point in enumerate(points):
        location = f'keyPoints[{index}]'
        text = point.get('text', '') if isinstance(point, dict) else point
        if not isinstance(text, str):
            flag('keypoint_text', location, 'Takeaway text must be a string.', 'error')
            continue
        if len(text.split()) > 30:
            flag('keypoint_length', location, 'Takeaway exceeds the 30-word target.')
        if isinstance(point, dict) and point.get('id') is not None:
            identity = point['id']
            if not isinstance(identity, str) or identity not in ids:
                flag('keypoint_reference', location, 'Takeaway references a story absent from this edition.', 'error')
            else:
                point_ids.append(identity)
    if points and any(identity not in point_ids for identity in featured):
        flag('featured_keypoint_missing', 'keyPoints', 'The linked takeaways do not cover every featured story; review coherence.')
    if point_ids and featured and point_ids[0] not in featured:
        flag('keypoint_lead', 'keyPoints[0]', 'The first linked takeaway is not a featured story; review the shared ranking.')

    registries = registries or {}
    def entries(name):
        registry = registries.get(name, document.get(name, {}))
        if not isinstance(registry, dict):
            flag('registry_shape', name, 'Expected a registry object.', 'error')
            return []
        registry = registry.get(name, registry)
        if not isinstance(registry, dict):
            flag('registry_shape', name, 'Expected a registry mapping.', 'error')
            return []
        for index, item in enumerate(registry.values()):
            if not isinstance(item, dict):
                flag('registry_entry_shape', f'{name}[{index}]', 'Registry entry must be an object.', 'error')
        return [(key, item) for key, item in registry.items() if isinstance(item, dict)]

    aliases = {}
    for index, (_, term) in enumerate(entries('terms')):
        names = term.get('aliases') or []
        if not isinstance(names, list):
            flag('term_alias_shape', f'terms[{index}]', 'Aliases must be an array.', 'error')
            names = []
        for name in [term.get('term'), *names]:
            if not isinstance(name, str):
                continue
            canonical = re.sub(r'[^\w]+', ' ', name.casefold()).strip()
            if not canonical:
                continue
            if canonical in aliases and aliases[canonical] != index:
                flag('term_alias_collision', f'terms[{index}]', 'A normalized name or alias is also assigned to another term; review canonical identity.')
            aliases[canonical] = index
    for index, (_, event) in enumerate(entries('events')):
        evidence = event.get('officialSource')
        if not isinstance(evidence, dict) or not http_url(evidence.get('url')) or not evidence.get('dateEvidence'):
            flag('event_official_evidence', f'events[{index}]', 'Dated event lacks an official source URL and supporting date evidence; verify rather than infer a calendar date.')
        if event.get('approx') == 'month' and str(event.get('date', '')).endswith('-01'):
            flag('event_month_precision', f'events[{index}]', 'Month-only date is a storage placeholder; never present its first day as a confirmed event day.')
    for index, (_, metric) in enumerate(entries('metrics')):
        location = f'metrics[{index}]'
        if not all(metric.get(field) for field in ('population', 'sector', 'geography', 'unit')):
            flag('metric_population', location, 'State the measured population, sector, geography and unit; do not turn an all-sector figure into an office figure.')
        series = metric.get('series', [])
        if not isinstance(series, list):
            flag('metric_series', location, 'Metric series must be an array.', 'error')
            continue
        for number, observation in enumerate(series):
            if not isinstance(observation, dict):
                flag('metric_observation', location+f'.series[{number}]', 'Observation must be an object.', 'error')
                continue
            if not finite_number(observation.get('value')):
                flag('metric_value', location+f'.series[{number}]', 'Observation value must be a finite number.', 'error')
            if not observation.get('asOf') or not observation.get('source') or not http_url(observation.get('sourceUrl')) or not observation.get('sourceQuote'):
                flag('metric_source', location+f'.series[{number}]', 'Retain the observation period, named source, source URL and short supporting passage.')
    return findings


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', help='Local daily JSON path, or YYYY-MM-DD under data/')
    parser.add_argument('--registry-dir', type=Path, help='Optional local folder containing terms.json, events.json and metrics.json')
    parser.add_argument('--json', action='store_true', help='Print machine-readable findings; never article text')
    args = parser.parse_args(argv)
    path = Path('data') / (args.input+'.json') if re.fullmatch(r'\d{4}-\d{2}-\d{2}', args.input) else Path(args.input)
    try:
        document = json.loads(path.read_text())
        registries = {}
        if args.registry_dir:
            if not args.registry_dir.is_dir():
                raise ValueError('Registry folder unavailable')
            for name in ('terms', 'events', 'metrics'):
                source = args.registry_dir / (name+'.json')
                if source.exists():
                    registries[name] = json.loads(source.read_text())
        findings = check_document(document, registries)
    except (OSError, ValueError, TypeError):
        print('Quality check could not read valid local JSON inputs. No files were changed.')
        return 2
    errors = sum(item['severity'] == 'error' for item in findings)
    warnings = len(findings)-errors
    if args.json:
        print(json.dumps({'errors': errors, 'warnings': warnings, 'findings': findings}, indent=2))
    else:
        print(f'Quality check: {errors} errors, {warnings} warnings. No files changed.')
        for item in findings:
            print(f"{item['severity'].upper()} {item['code']} at {item['location']}: {item['message']}")
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
