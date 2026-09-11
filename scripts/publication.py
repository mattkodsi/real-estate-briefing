"""Validated publication with atomic JSON compare-and-swap and narrow enrichment.

Requires 202609110001_publication_integrity.sql. No fallback to unsafe upserts.
"""
from content_quality import assess_content
from editorial_quality import prepare_editorial, validate_claims
import copy
import html
import json
import math
import re
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone

SUPABASE_URL = 'https://uhwdnmbxiopfysodydty.supabase.co'
ANON_KEY = 'sb_publishable_LEQ5_-jjcRRl2p0wlaiXcw_RX4Wf8-y'
KEYS = {'days': 'date', 'weeks': 'week_of', 'players': 'slug', 'terms': 'slug',
        'threads': 'slug', 'campaigns': 'slug', 'events': 'id', 'metrics': 'id'}
ENRICHMENT_FIELDS = ('content', 'image', 'url', 'imageChecked', 'sourceBlocked', 'fillAttemptedAt', 'contentStatus', 'fillError', 'publisher', 'coverage')
MISSING = object()


def utcnow():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def validate_date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('Expected YYYY-MM-DD')
    date.fromisoformat(value)
    return value


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('A timezone-aware generatedAt is required')
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('Timestamp must include timezone')
    return result


def validate_document(table, doc):
    if table not in KEYS or not isinstance(doc, dict):
        raise ValueError('Unknown table or malformed document')
    if doc.get('generatedAt') is not None:
        timestamp(doc['generatedAt'])
    if table in ('days', 'weeks'):
        validate_date(doc.get('date' if table == 'days' else 'weekOf'))
        timestamp(doc.get('generatedAt'))
    if table == 'days':
        stories = doc.get('stories')
        if not isinstance(stories, list):
            raise ValueError('stories must be an array')
        ids = set()
        for story in stories:
            if not isinstance(story, dict) or not isinstance(story.get('id'), str) or not story['id'].strip():
                raise ValueError('Each story needs a nonempty string id')
            if story['id'] in ids:
                raise ValueError('Duplicate story id: ' + story['id'])
            ids.add(story['id'])
    def walk(value, parent=None):
        if isinstance(value, dict):
            for key, item in value.items():
                if key in ('url', 'image') and item is not None:
                    if not isinstance(item, str):
                        raise ValueError(key + ' must be an HTTP(S) URL')
                    parsed = urllib.parse.urlparse(item)
                    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
                        raise ValueError(key + ' must be an HTTP(S) URL')
                # Evidence is keyed by the field it documents; the actual
                # financial value remains validated on the story itself.
                if parent != 'fieldEvidence' and key in ('valueUsd', 'noi', 'sizeSqft', 'units', 'capRate') and item is not None:
                    if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item) or item < 0:
                        raise ValueError(key + ' must be a finite nonnegative number')
                walk(item, key)
        elif isinstance(value, list):
            for item in value: walk(item)
    walk(doc)
    json.dumps(doc, allow_nan=False)


class Client:
    def request(self, path, data=None):
        req = urllib.request.Request(SUPABASE_URL + '/rest/v1/' + path,
            data=None if data is None else json.dumps(data, allow_nan=False).encode(),
            headers={'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY,
                     'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)

    def read(self, table, key):
        query = urllib.parse.urlencode({KEYS[table]: 'eq.' + key, 'select': 'data'})
        rows = self.request(table + '?' + query)
        return rows[0]['data'] if rows else None

    def compare_swap(self, table, key, expected, replacement):
        return self.request('rpc/publication_compare_swap', {
            'p_table': table, 'p_key': key, 'p_expected': expected, 'p_data': replacement}) is True


def content_words(value):
    return len(html.unescape(re.sub(r'<[^>]+>', ' ', str(value or ''))).split())


def stamp_editorial(doc, current, now):
    """Record observed publication transitions, never inferred historical times."""
    result = prepare_editorial(doc, current)
    previous = {story['id']: story for story in (current or {}).get('stories', [])}
    for story in result.get('stories', []):
        before = previous.get(story['id'])
        if before and story.get('url') == before.get('url') and not story.get('content') and assess_content(before.get('content'))['ready']:
            for key in ('content','image','contentStatus','contentReadyAt'):
                if key in before and not story.get(key):
                    story[key] = copy.deepcopy(before[key])
        validate_claims(story)
        # These fields are publication observations; preserve the remote record,
        # not generator-provided guesses or timestamps copied from another story.
        for field in ('firstPublishedAt', 'summaryPublishedAt', 'contentReadyAt'):
            if before is not None and field in before:
                story[field] = before[field]
            else:
                story.pop(field, None)
        if before is None:
            story['firstPublishedAt'] = now
        if before is None or any(story.get(field) != before.get(field) for field in ('title', 'summary')):
            story['summaryPublishedAt'] = now
        ready = assess_content(story.get('content'))
        story['contentStatus'] = ready['status']
        if not ready['ready']:
            story.pop('contentReadyAt', None)
        if ready['ready'] and (before is None or not assess_content(before.get('content'))['ready']):
            story['contentReadyAt'] = now
    return result


def merge_enrichment(base, edited, current, worker, now):
    """Three-way per-field merge. A changed source URL invalidates the fetch.

    Another worker's change to a field always wins; untouched independent fields
    can still be enriched. Missing/deleted stories are never resurrected.
    """
    result = copy.deepcopy(current)
    old = {s['id']: s for s in base.get('stories', [])}
    new = {s['id']: s for s in edited.get('stories', [])}
    changed = False
    for story in result.get('stories', []):
        before, after = old.get(story['id']), new.get(story['id'])
        if before is None or after is None or story.get('url') != before.get('url'):
            continue
        was_ready = assess_content(story.get("content"))["ready"]
        touched = False
        bundle = ('url', 'content', 'publisher', 'coverage', 'image', 'contentStatus', 'fillError')
        adopting = after.get('url') != before.get('url') or after.get('publisher') != before.get('publisher')
        bundle_conflict = (story.get('publisher') != before.get('publisher') or story.get('coverage') != before.get('coverage')) or (adopting and any(story.get(k, MISSING) != before.get(k, MISSING) for k in bundle))
        for field in ENRICHMENT_FIELDS:
            if bundle_conflict and field in bundle:
                continue
            prior, desired = before.get(field, MISSING), after.get(field, MISSING)
            if prior == desired or story.get(field, MISSING) != prior:
                continue
            if desired is MISSING:
                story.pop(field, None)
            else:
                story[field] = copy.deepcopy(desired)
            touched = changed = True
        if touched:
            validate_claims(story)
            story['enrichedAt'] = now
            story['enrichedBy'] = worker
            ready = assess_content(story.get('content'))
            story['contentStatus'] = ready['status']
            if not ready['ready']:
                story.pop('contentReadyAt', None)
            if not was_ready and ready['ready']:
                story['contentReadyAt'] = now
    if changed:
        result['generatedAt'] = now
        result['publishedAt'] = now
    return result


def publish_enrichment(base, edited, worker, client=None, attempts=4):
    client = client or Client()
    validate_document('days', base)
    for _ in range(attempts):
        current = client.read('days', base['date'])
        if current is None:
            raise RuntimeError('Published day disappeared; refusing to recreate it')
        merged = merge_enrichment(base, edited, current, worker, utcnow())
        if merged == current:
            return current
        validate_document('days', merged)
        if client.compare_swap('days', base['date'], current, merged):
            return merged
    raise RuntimeError('Publication conflict after bounded retries; rerun against fresh data')


def validate_research_publication(table, doc, current, client):
    from reference_repair import reference_containers, reviewed_unavailable, validate_registry_references
    if table not in ('players','terms','threads','campaigns'):
        return
    old_refs=[r for _,refs in reference_containers(table,current or {}) for r in refs if isinstance(r,dict)]
    dates={}
    for _, refs in reference_containers(table,doc):
        for ref in refs:
            if reviewed_unavailable(ref):
                if ref not in old_refs:
                    raise ValueError('New source-unavailable markers require an evidence-reviewed repair')
                continue
            if not isinstance(ref,dict) or not ref.get('date'):
                continue
            date=validate_date(ref['date'])
            if date not in dates:
                dates[date]=client.read('days',date)
    if table == 'players':
        for _, refs in reference_containers(table,doc):
            for ref in refs:
                if not isinstance(ref,dict) or reviewed_unavailable(ref): continue
                source=next((s for s in (dates.get(ref.get('date')) or {}).get('stories',[]) if s.get('id')==ref.get('id')),{})
                if any(c.get('incorrect','').casefold()==str(doc.get('name','')).casefold() for c in source.get('identityCorrections',[])):
                    raise ValueError('Previously corrected profile/story identity reintroduced')
    errors=validate_registry_references(table,doc,dates)
    if errors:
        raise ValueError('Research reference validation failed: '+str(errors))


def publish_document(table, key, doc, client=None):
    """Editorial publication must be newer; a racing change requires regeneration."""
    client = client or Client()
    validate_document(table, doc)
    current = client.read(table, key)
    if current is not None and {k:v for k,v in current.items() if k != 'publishedAt'} == {k:v for k,v in doc.items() if k != 'publishedAt'}:
        return
    now = utcnow()
    # stamp_editorial preserves reviewed thread corrections and rejects known
    # dangling targets. Broad existence checks need a batch overlay first:
    # push_data currently publishes each day before its newly-created threads.
    replacement = stamp_editorial(doc, current, now) if table == "days" else copy.deepcopy(doc)
    if current is not None and {k: v for k, v in current.items() if k != "publishedAt"} == {k: v for k, v in replacement.items() if k != "publishedAt"}:
        return
    if current is not None:
        old_time = current.get('generatedAt') or current.get('publishedAt')
        if old_time and timestamp(doc.get('generatedAt')) <= timestamp(old_time):
            raise RuntimeError('Refusing stale or same-timestamp replacement: ' + table + '/' + key)
    if table in ('players','terms') and current and all(current.get(k)==replacement.get(k) for k in ('name','term','type')):
        for field in ('researchReviews','relatedResearch','researchCorrections'):
            if field in current and field not in replacement: replacement[field]=copy.deepcopy(current[field])
    validate_research_publication(table, replacement, current, client)
    replacement['publishedAt'] = now
    if not client.compare_swap(table, key, current, replacement):
        raise RuntimeError('Concurrent publication; reload before publishing ' + table + '/' + key)
