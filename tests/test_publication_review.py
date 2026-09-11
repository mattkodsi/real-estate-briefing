"""Regression coverage for independently reviewed worker compatibility."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import publication
import fill_content
import fill_browser
import watchdog

class WorkerCompatibilityTests(unittest.TestCase):
    def test_fresh_fractional_timestamp_does_not_trigger_failover(self):
        with patch.object(fill_content, 'read_heartbeat', return_value={'lastRun': publication.utcnow(), 'via': 'github-actions'}), patch.object(watchdog, 'notify') as notify, patch.object(watchdog.subprocess, 'run') as run:
            self.assertEqual(watchdog.main(), 0)
            notify.assert_not_called()
            run.assert_not_called()

    def test_browser_no_push_changes_can_be_published(self):
        base = {'date': '2026-09-11', 'generatedAt': '2026-09-11T00:00:00Z', 'stories': [{'id': 'a', 'title': 'Story', 'url': 'https://a-prod.bisnow.io/s/fabricated-slug'}]}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / '2026-09-11.json'
            with patch.object(fill_content, 'load_day', return_value=(copy.deepcopy(base), path)), patch.object(fill_content, 'DATA', Path(folder)):
                fill_browser._fill_one_day(None, None, set(), base['date'], True)
            edited = json.loads(path.read_text())
            self.assertNotIn('url', edited['stories'][0])
            self.assertGreater(publication.timestamp(edited['generatedAt']), publication.timestamp(base['generatedAt']))
            class LocalOnly:
                def read(self, *args): return base
                def compare_swap(self, *args): return True
            publication.publish_document('days', base['date'], edited, LocalOnly())

    def test_running_primary_is_a_live_heartbeat(self):
        import io
        response = io.BytesIO(json.dumps([{'data': {'state': 'running', 'lastRun': publication.utcnow()}}]).encode())
        with patch.object(fill_content.urllib.request, 'urlopen', return_value=response):
            self.assertIsNotNone(fill_content.read_heartbeat())

if __name__ == '__main__': unittest.main()

class FairAttemptTests(unittest.TestCase):
    def test_browser_budget_continues_with_unattempted_story_next_run(self):
        from contextlib import ExitStack
        base = {'date':'2026-09-11','generatedAt':'2026-09-11T00:00:00Z','stories':[{'id':str(i),'title':'Story','url':f'https://example.com/{i}'} for i in range(2)]}
        fetched = []
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'2026-09-11.json'; path.write_text(json.dumps(base))
            with ExitStack() as stack:
                stack.enter_context(patch.object(fill_content,'load_day',side_effect=lambda *a:(json.loads(path.read_text()),path)))
                stack.enter_context(patch.object(fill_content,'DATA',Path(folder)))
                stack.enter_context(patch.object(fill_browser,'_cookies_for',return_value=[]))
                stack.enter_context(patch.object(fill_browser,'fetch_with_browser',side_effect=lambda page,url:(fetched.append(url) or '',url)))
                stack.enter_context(patch.object(fill_browser.fetch_article,'extract_from_html',return_value={'ok':False,'words':0}))
                stack.enter_context(patch.object(fill_browser.fetch_article,'extract',return_value=None))
                for run in range(2):
                    with patch.object(fill_browser.time,'monotonic',side_effect=[0,2]):
                        fill_browser._fill_one_day(None,None,set(),base['date'],True,deadline=1)
                    if run == 0:
                        snapshot=json.loads(path.read_text())
                        self.assertNotIn('fillAttemptedAt',snapshot['stories'][1])
            self.assertEqual(fetched,['https://example.com/0','https://example.com/1'])
            edited=json.loads(path.read_text())
            self.assertTrue(all(story.get('fillAttemptedAt') for story in edited['stories']))

    def test_http_budget_continues_and_attempt_metadata_merges(self):
        base={'date':'2026-09-11','generatedAt':'2026-09-11T00:00:00Z','stories':[{'id':str(i),'url':f'https://example.com/{i}'} for i in range(2)]}
        edited=copy.deepcopy(base); fetched=[]
        with patch.object(fill_content,'_try_story',side_effect=lambda story:(fetched.append(story['id']) or 'blocked','wall')):
            for _ in range(2):
                with patch.object(fill_content.time,'monotonic',side_effect=[0,0,2,2]):
                    fill_content.fill_day(edited,throttle=0,max_seconds=1)
        self.assertEqual(fetched,['0','1'])
        merged=publication.merge_enrichment(base,edited,base,'test',publication.utcnow())
        self.assertTrue(all(story.get('fillAttemptedAt') for story in merged['stories']))
