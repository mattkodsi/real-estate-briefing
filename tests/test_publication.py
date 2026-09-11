import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import publication as p


def day():
    return {'date': '2026-09-11', 'generatedAt': '2026-09-11T12:00:00Z', 'stories': [
        {'id': 'a', 'title': 'Original', 'url': 'https://example.com/a', 'content': None},
        {'id': 'b', 'title': 'Other', 'url': 'https://example.com/b'}]}

class PublicationTests(unittest.TestCase):
    def test_merge_preserves_editorial_and_other_article(self):
        base = day(); edited = copy.deepcopy(base); current = copy.deepcopy(base)
        edited['stories'][0]['content'] = 'fetched'
        edited['stories'][0]['title'] = 'accidental rewrite'
        current['stories'][0]['title'] = 'New editorial headline'
        current['stories'][1]['content'] = 'other worker'
        current['stories'].reverse()
        merged = p.merge_enrichment(base, edited, current, 'test', 'now')
        self.assertEqual(merged['stories'][0]['content'], 'other worker')
        self.assertEqual(merged['stories'][1]['title'], 'New editorial headline')
        self.assertEqual(merged['stories'][1]['content'], 'fetched')

    def test_changed_url_rejects_old_fetch(self):
        base = day(); edited = copy.deepcopy(base); current = copy.deepcopy(base)
        edited['stories'][0]['content'] = 'wrong article'
        current['stories'][0]['url'] = 'https://example.com/corrected'
        self.assertEqual(p.merge_enrichment(base, edited, current, 'test', 'now'), current)

    def test_field_conflict_preserves_new_content_but_adds_image(self):
        base = day(); edited = copy.deepcopy(base); current = copy.deepcopy(base)
        edited['stories'][0].update(content='fetched', image='https://example.com/img')
        current['stories'][0]['content'] = 'newer text'
        merged = p.merge_enrichment(base, edited, current, 'test', 'now')
        self.assertEqual(merged['stories'][0]['content'], 'newer text')
        self.assertEqual(merged['stories'][0]['image'], 'https://example.com/img')

    def test_status_and_removal_are_real_changes(self):
        base = day(); base['stories'][0]['sourceBlocked'] = True
        edited = copy.deepcopy(base); del edited['stories'][0]['sourceBlocked']
        edited['stories'][0]['imageChecked'] = True
        merged = p.merge_enrichment(base, edited, base, 'test', 'now')
        self.assertNotIn('sourceBlocked', merged['stories'][0])
        self.assertTrue(merged['stories'][0]['imageChecked'])
        self.assertEqual(merged['stories'][0]['enrichedAt'], 'now')

    def test_validation(self):
        p.validate_document('days', day())
        for field, value in [('valueUsd', True), ('valueUsd', '100'), ('url', 'javascript:alert(1)')]:
            bad = day(); bad['stories'][0][field] = value
            with self.assertRaises(ValueError): p.validate_document('days', bad)
        bad = day(); bad['stories'].append(bad['stories'][0])
        with self.assertRaises(ValueError): p.validate_document('days', bad)
        with self.assertRaises(ValueError): p.validate_date('2026-02-30')

    def test_retry_reloads_and_noop(self):
        base = day(); edited = copy.deepcopy(base); edited['stories'][0]['content'] = 'fetched'
        class Fake:
            def __init__(self): self.doc = day(); self.calls = 0
            def read(self, table, key): return copy.deepcopy(self.doc)
            def compare_swap(self, table, key, expected, replacement):
                self.calls += 1
                if self.calls == 1:
                    self.doc['stories'][1]['title'] = 'Concurrent edit'
                    return False
                self.doc = replacement; return True
        client = Fake()
        result = p.publish_enrichment(base, edited, 'test', client=client)
        self.assertEqual(client.calls, 2)
        self.assertEqual(result['stories'][1]['title'], 'Concurrent edit')
        p.publish_enrichment(result, result, 'test', client=client)
        self.assertEqual(client.calls, 2)

    def test_exhausted_conflict_raises(self):
        base = day(); edited = copy.deepcopy(base); edited['stories'][0]['imageChecked'] = True
        class Fake:
            def read(self, *args): return base
            def compare_swap(self, *args): return False
        with self.assertRaises(RuntimeError): p.publish_enrichment(base, edited, 'test', client=Fake())

class IntegrationTests(unittest.TestCase):
    def test_scoped_week(self):
        import tempfile
        import push_data
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root / 'weeks').mkdir()
            for value in ('2026-09-11', '2026-09-10'): (root / (value + '.json')).touch()
            for value in ('2026-09-07', '2026-08-31'): (root / 'weeks' / (value + '.json')).touch()
            days, weeks = push_data.publication_paths(root, '2026-09-11')
            self.assertEqual([x.stem for x in days], ['2026-09-11'])
            self.assertEqual([x.stem for x in weeks], ['2026-09-07'])
            self.assertEqual(push_data.publication_paths(root), ([], []))

    def test_legacy_default_is_today_and_fresh_registries_only(self):
        import json
        import tempfile
        import push_data
        from unittest.mock import patch
        from datetime import datetime
        from zoneinfo import ZoneInfo
        today = datetime.now(ZoneInfo('America/New_York')).date().isoformat()
        current = day(); current['date'] = today; current['generatedAt'] = p.utcnow()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / (today + '.json')).write_text(json.dumps(current))
            (root / '2020-01-01.json').write_text('{}')
            (root / 'players.json').write_text(json.dumps({'generatedAt': p.utcnow(), 'players': {'fresh': {'name': 'Fresh'}}}))
            (root / 'terms.json').write_text(json.dumps({'generatedAt': '2020-01-01T12:00:00Z', 'terms': {}}))
            with patch('sys.argv', ['push_data.py']), patch.object(push_data, 'DATA', root), patch.object(push_data, 'push_day') as days, patch.object(push_data, 'push_keyed') as registries:
                push_data.main()
                days.assert_called_once_with(root / (today + '.json'))
                registries.assert_called_once_with(root / 'players.json', 'players', 'players', 'slug')

    def test_published_load_ignores_stale_local(self):
        from unittest.mock import patch
        import fill_content
        with patch.object(fill_content, '_load_local') as local, patch.object(fill_content, '_load_supabase', return_value=day()) as remote:
            actual, _ = fill_content.load_day('2026-09-11')
            self.assertEqual(actual, day())
            local.assert_not_called(); remote.assert_called_once()

    def test_image_only_eligibility(self):
        import fill_content
        story = {'url': 'https://example.com/a', 'content': 'word ' * 130}
        self.assertTrue(fill_content.needs_enrichment(story))
        story['imageChecked'] = True
        self.assertFalse(fill_content.needs_enrichment(story))

    def test_stale_editorial_rejected_and_idempotent_publish(self):
        base = day()
        class Fake:
            calls = 0
            def read(self, *args): return {**base, 'publishedAt': '2026-09-11T12:01:00Z'}
            def compare_swap(self, *args): self.calls += 1; return True
        client = Fake()
        p.publish_document('days', base['date'], base, client)
        self.assertEqual(client.calls, 0)
        bad = copy.deepcopy(base); bad['stories'][0]['title'] = 'Stale rewrite'
        with self.assertRaises(RuntimeError): p.publish_document('days', base['date'], bad, client)

    def test_failure_is_not_success(self):
        from unittest.mock import patch
        import fill_content
        with patch('sys.argv', ['fill_content.py', '2026-09-11']), patch.object(fill_content, 'load_day', return_value=(day(), Path('/tmp/unused-publication.json'))), patch.object(fill_content, 'fill_day', return_value={'filled': [], 'failed': []}), patch.object(fill_content, 'record_heartbeat'), patch.object(fill_content, '_push', side_effect=RuntimeError('offline')):
            self.assertEqual(fill_content.main(), 1)

    def test_deleted_story_not_resurrected(self):
        base = day(); edited = copy.deepcopy(base); current = copy.deepcopy(base)
        edited['stories'][0]['content'] = 'fetched'; current['stories'].pop(0)
        self.assertEqual(p.merge_enrichment(base, edited, current, 'test', 'now'), current)

class TimingTests(unittest.TestCase):
    def test_content_ready_only_when_readable_content_crosses_threshold(self):
        base = day(); edited = copy.deepcopy(base)
        edited['stories'][0]['image'] = 'https://example.com/image'
        merged = p.merge_enrichment(base, edited, base, 'test', 'now')
        self.assertNotIn('contentReadyAt', merged['stories'][0])
        edited['stories'][0]['content'] = '<p>' + 'word ' * 120 + '</p>'
        merged = p.merge_enrichment(base, edited, base, 'test', 'now')
        self.assertEqual(merged['stories'][0]['contentReadyAt'], 'now')
        self.assertNotIn('summaryPublishedAt', merged['stories'][0])
        legacy = copy.deepcopy(edited); changed = copy.deepcopy(legacy)
        changed['stories'][0]['imageChecked'] = True
        self.assertNotIn('contentReadyAt', p.merge_enrichment(legacy, changed, legacy, 'test', 'later')['stories'][0])

    def test_editorial_timestamps_and_same_input_idempotency(self):
        from unittest.mock import patch
        class Fake:
            doc = None
            writes = 0
            def read(self, *args): return copy.deepcopy(self.doc)
            def compare_swap(self, table, key, expected, replacement):
                self.doc = copy.deepcopy(replacement); self.writes += 1; return True
        client = Fake(); incoming = day()
        incoming['stories'][0]['content'] = 'word ' * 120
        with patch.object(p, 'utcnow', return_value='2026-09-11T12:01:00Z'):
            p.publish_document('days', incoming['date'], incoming, client)
        self.assertEqual(client.doc['stories'][0]['summaryPublishedAt'], '2026-09-11T12:01:00Z')
        self.assertEqual(client.doc['stories'][0]['contentReadyAt'], '2026-09-11T12:01:00Z')
        p.publish_document('days', incoming['date'], incoming, client)
        self.assertEqual(client.writes, 1)
        incoming['generatedAt'] = '2026-09-11T12:02:00Z'
        incoming['stories'][0]['summary'] = 'Changed summary'
        with patch.object(p, 'utcnow', return_value='2026-09-11T12:03:00Z'):
            p.publish_document('days', incoming['date'], incoming, client)
        self.assertEqual(client.doc['stories'][0]['summaryPublishedAt'], '2026-09-11T12:03:00Z')
        self.assertEqual(client.doc['stories'][0]['contentReadyAt'], '2026-09-11T12:01:00Z')
        self.assertEqual(client.doc['stories'][1]['summaryPublishedAt'], '2026-09-11T12:01:00Z')

    def test_unchanged_legacy_story_does_not_get_backdated_timestamps(self):
        from unittest.mock import patch
        base = day(); base['stories'][0]['content'] = 'word ' * 120
        class Fake:
            doc = base
            def read(self, *args): return self.doc
            def compare_swap(self, table, key, expected, replacement): self.doc = replacement; return True
        client = Fake(); incoming = copy.deepcopy(base)
        incoming['generatedAt'] = '2026-09-11T12:02:00Z'
        incoming['stories'][0]['section'] = 'Policy'
        incoming['stories'][0]['summaryPublishedAt'] = '2000-01-01T00:00:00Z'
        incoming['stories'][0]['contentReadyAt'] = '2000-01-01T00:00:00Z'
        p.publish_document('days', incoming['date'], incoming, client)
        self.assertNotIn('summaryPublishedAt', client.doc['stories'][0])
        self.assertNotIn('contentReadyAt', client.doc['stories'][0])

if __name__ == '__main__': unittest.main()
