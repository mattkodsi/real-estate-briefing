"""Worker startup errors must release failover through a failed pulse."""
import contextlib
import io
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import fill_browser


class WorkerStartupTests(unittest.TestCase):
    def run_worker(self, modules, no_push=False, load_error=None):
        pulses = []
        with patch.object(sys, 'argv', ['fill_browser.py', '2026-09-11'] + (['--no-push'] if no_push else [])), patch.dict(sys.modules, modules), patch.object(fill_browser.fill_content, 'record_heartbeat', side_effect=lambda *args, **kw: pulses.append((args, kw))), patch.object(fill_browser.fill_content, 'load_day', side_effect=load_error, return_value=({'stories': [{'url': 'https://example.com/article', 'content': None}]}, None)), contextlib.redirect_stdout(io.StringIO()):
            try:
                result = fill_browser.main()
            except Exception:
                result = 'uncaught'
        return result, pulses

    def test_missing_playwright_records_failed_and_exits_nonzero(self):
        result, pulses = self.run_worker({'playwright.sync_api': None})
        self.assertEqual(pulses[-1][1].get('state'), 'failed')
        self.assertGreaterEqual(pulses[-1][0][2], 1)
        self.assertEqual(result, 1)

    def test_launch_failure_records_failed(self):
        class Runtime:
            def __enter__(self):
                self.chromium = self
                return self
            def __exit__(self, *args):
                return False
            def launch(self, **kwargs):
                raise RuntimeError('browser executable missing')
        module = types.ModuleType('playwright.sync_api')
        module.sync_playwright = Runtime
        result, pulses = self.run_worker({'playwright.sync_api': module})
        self.assertEqual(pulses[-1][1].get('state'), 'failed')
        self.assertEqual(result, 1)

    def test_load_failure_records_failed(self):
        result, pulses = self.run_worker({}, load_error=RuntimeError('load unavailable'))
        self.assertEqual(pulses[-1][1].get('state'), 'failed')
        self.assertEqual(result, 1)

    def test_no_push_failure_does_not_publish_heartbeat(self):
        result, pulses = self.run_worker({'playwright.sync_api': None}, no_push=True)
        self.assertEqual(pulses, [])
        self.assertEqual(result, 1)
