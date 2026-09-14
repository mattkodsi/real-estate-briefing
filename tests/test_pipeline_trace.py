import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))

class TraceTests(unittest.TestCase):
    def trace_module(self):
        self.assertIsNotNone(importlib.util.find_spec('pipeline_trace'), 'durable stage tracing is not implemented')
        import pipeline_trace
        return pipeline_trace

    def test_failure_is_logged_and_original_exception_is_preserved(self):
        t = self.trace_module()
        with tempfile.TemporaryDirectory() as root:
            with t.Run('test', directory=root, transport=lambda events: True) as run:
                with self.assertRaisesRegex(ValueError, 'private message'):
                    with run.phase('article.fetch', entity_type='story', entity_key='2026-09-14/a'):
                        raise ValueError('private message containing a token')
            events = [json.loads(s) for s in run.path.read_text().splitlines()]
            stage = [e for e in events if e['stage'] == 'article.fetch']
            self.assertEqual([e['status'] for e in stage], ['started','failed'])
            self.assertEqual(stage[0]['details']['span_id'], stage[1]['details']['span_id'])
            self.assertEqual(stage[1]['details']['error_type'], 'ValueError')
            self.assertNotIn('private message', json.dumps(events))
            self.assertGreaterEqual(stage[1]['details']['duration_ms'], 0)

    def test_failed_upload_retains_events_for_idempotent_replay(self):
        t = self.trace_module()
        with tempfile.TemporaryDirectory() as root:
            run=t.Run('test', directory=root, transport=lambda events: (_ for _ in ()).throw(OSError('secret')))
            run.emit('email.read', 'completed', entity_type='email', entity_key='a'*64,
                     details={'source_hash':'a'*64,'body':'private','token':'secret'})
            self.assertFalse(run.flush())
            pending=t.pending_events(run.path)
            self.assertEqual(len(pending),1)
            self.assertNotIn('body',pending[0]['details'])
            self.assertNotIn('token',pending[0]['details'])
            batches=[]
            run.transport=lambda events: batches.append(events) or True
            self.assertTrue(run.flush())
            self.assertEqual(batches[0][0]['id'],pending[0]['id'])
            self.assertEqual(t.pending_events(run.path),[])

    def test_correlation_headers_do_not_exist_outside_run(self):
        t=self.trace_module()
        self.assertEqual(t.headers(),{})
        with tempfile.TemporaryDirectory() as root:
            with t.Run('test',directory=root,transport=lambda events:True) as run:
                self.assertEqual(t.headers()['x-briefing-run-id'],run.run_id)
            self.assertEqual(t.headers(),{})

    def test_unknown_phases_are_not_fabricated(self):
        t=self.trace_module()
        with tempfile.TemporaryDirectory() as root:
            with t.Run('publisher',directory=root,transport=lambda events:True) as run:
                run.emit('publication.write','completed')
            events=[json.loads(s) for s in run.path.read_text().splitlines()]
            self.assertNotIn('email.read',{e['stage'] for e in events})
            self.assertTrue(all(e.get('observed_at') for e in events))
            self.assertTrue(all('recorded_at' not in e for e in events))

    def test_unreadable_spool_cannot_prevent_work_or_replace_error(self):
        t=self.trace_module()
        with tempfile.TemporaryDirectory() as root:
            run=t.Run('test',directory=root,transport=lambda events:True)
            with patch.object(Path,'exists',side_effect=PermissionError('private path')):
                entered=False
                with self.assertRaisesRegex(ValueError,'original'):
                    with run:
                        entered=True
                        raise ValueError('original')
                self.assertTrue(entered)

    def test_execution_route_and_nested_deliverable_context_survive(self):
        t=self.trace_module()
        with tempfile.TemporaryDirectory() as root:
            with t.Run('browser-worker',directory=root,transport=lambda events:True,context={'executor':'github-actions'}) as run:
                with run.phase('article.attempt',entity_type='story',entity_key='2026-09-14/a'):
                    with run.phase('article.browser',details={'method':'playwright-chromium'}): pass
            events=[json.loads(s) for s in run.path.read_text().splitlines()]
            attempt=next(e for e in events if e['stage']=='article.attempt')
            browser=next(e for e in events if e['stage']=='article.browser')
            self.assertEqual(browser['entity_key'],'2026-09-14/a')
            self.assertEqual(browser['details']['executor'],'github-actions')
            self.assertEqual(browser['details']['method'],'playwright-chromium')
            self.assertEqual(browser['details']['parent_span_id'],attempt['details']['span_id'])
            self.assertNotIn('model',browser['details'])

    def test_conflicted_publication_never_claims_a_saved_write(self):
        t=self.trace_module()
        import publication
        class Client:
            def read(self,*args): return None
            def compare_swap(self,*args): return False
        doc={'date':'2026-09-14','generatedAt':'2026-09-14T12:00:00Z','stories':[]}
        with tempfile.TemporaryDirectory() as root:
            with t.Run('publisher',directory=root,transport=lambda events:True) as run:
                with self.assertRaises(RuntimeError): publication.publish_document('days',doc['date'],doc,client=Client())
            events=[json.loads(s) for s in run.path.read_text().splitlines()]
            writes=[e['status'] for e in events if e['stage']=='publication.write']
            self.assertEqual(writes,['conflict'])

    def test_detailed_events_are_batched_by_bytes_as_well_as_count(self):
        t=self.trace_module()
        batches=[]
        def transport(events):
            self.assertLessEqual(len(json.dumps({'events':events}).encode()),131072)
            batches.append(events)
            return True
        with tempfile.TemporaryDirectory() as root:
            run=t.Run('test',directory=root,transport=transport)
            details={k:'a'*180 for k in t.TEXT_KEYS if k not in ('receipt_at','source_hash','input_hash','artifact_hash')}
            for _ in range(100): run.emit('trace.test','completed',details=details)
            self.assertTrue(run.flush())
            self.assertGreater(len(batches),1)
            self.assertEqual(sum(map(len,batches)),100)
            self.assertEqual(t.pending_events(run.path),[])

if __name__=='__main__': unittest.main()
