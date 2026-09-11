import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
try:
    import report_delivery as report
except ModuleNotFoundError:
    report = None


class DeliveryReportTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(report, 'delivery reporter must exist')

    def test_coverage_denominators_and_only_valid_pairs(self):
        result = report.build_report({'stories': [
            {'summaryPublishedAt': '2026-09-11T10:00:00-04:00', 'contentReadyAt': '2026-09-11T14:02:00Z'},
            {'summaryPublishedAt': '2026-09-11T14:03:00Z', 'contentReadyAt': '2026-09-11T14:02:00Z'},
            {'summaryPublishedAt': 'bad', 'contentReadyAt': '2026-09-11T14:02:00Z'},
            {'summaryPublishedAt': '2026-09-11T14:00:00'},
            {},
        ]})
        self.assertEqual(result['stories'], 5)
        self.assertEqual(result['timestamps']['summaryPublishedAt'], {'valid': 2, 'missing': 1, 'malformed': 2, 'denominator': 5})
        self.assertEqual(result['summary_to_ready']['excluded'], {'missing_timestamp': 2, 'malformed_timestamp': 1, 'backwards': 1})
        self.assertEqual(result['summary_to_ready']['sample_count'], 1)
        self.assertEqual(result['summary_to_ready']['median_seconds'], 120)

    def test_rows_ready_threshold_empty_sample_and_no_identifiers(self):
        data = [{'data': {'stories': [{'id': 'private-id', 'content': '<p>' + ('The lender approved financing for the apartment project after reviewing leasing results and the construction budget. ' * 8) + '</p>', 'summaryPublishedAt': None}]}}]
        result = report.build_report(data)
        self.assertEqual(result['current_content_ready'], 1)
        self.assertIsNone(result['summary_to_ready']['median_seconds'])
        self.assertNotIn('private-id', json.dumps(result))
        self.assertEqual(report.build_report([])['stories'], 0)

    def test_rejects_malformed_documents_instead_of_silent_undercount(self):
        for data in ({}, {'stories': [None]}, [{'data': {'stories': 'bad'}}]):
            with self.assertRaises(ValueError):
                report.build_report(data)

    def test_job_aggregates_do_not_leak_extra_fields(self):
        jobs = [{'state': 'sent', 'count': 3, 'valid_latency_count': 2, 'latency_sum_seconds': 18, 'endpoint': 'private'}]
        result = report.build_report({'stories': []}, jobs)
        self.assertEqual(result['push_jobs']['total'], 3)
        self.assertEqual(result['push_jobs']['provider_acceptance']['sample_count'], 2)
        self.assertEqual(result['push_jobs']['provider_acceptance']['mean_seconds'], 9)
        self.assertNotIn('private', json.dumps(result))
        with self.assertRaises(ValueError):
            report.build_report({'stories': []}, [{'state': 'sent', 'count': 1, 'valid_latency_count': 2}])

    def test_job_latency_requires_explicit_sum(self):
        with self.assertRaises(ValueError):
            report.build_report({'stories': []}, [{'state': 'sent', 'count': 2, 'valid_latency_count': 2}])

    def test_readiness_rejects_long_gate_and_accepts_short_prose(self):
        prose = '<p>' + ('The project received financing after the lender reviewed the construction budget and leasing results. ' * 5) + '</p>'
        gated = prose + '<p>Subscribe to continue reading the article.</p>'
        result = report.build_report({'stories': [{'content': prose}, {'content': gated}]})
        self.assertEqual(result['current_content_ready'], 1)

    def test_mailbox_latency_requires_verified_url_hash_and_timezone(self):
        def story(receipts, **extra):
            return {'url': 'https://news.test/a', 'firstPublishedAt': '2026-09-11T14:02:00Z', 'sourceReceipts': receipts, **extra}
        receipt = {'provider': 'gmail', 'messageHash': 'a' * 64, 'url': 'https://news.test/a', 'receivedAt': '2026-09-11T10:00:00-04:00'}
        cases = [story([receipt]), story([], receivedAt='2026-09-11T14:00:00Z')]
        cases += [story([{**receipt, **change}]) for change in (
            {'provider': 'unknown'}, {'messageHash': 'raw-message-id'}, {'url': 'https://other.test/a'}, {'receivedAt': '2026-09-11T14:00:00'}, {'receivedAt': 'bad'})]
        cases += [story([receipt], firstPublishedAt='2026-09-11T13:00:00Z'), story([receipt], firstPublishedAt='bad'), story([receipt], firstPublishedAt=None)]
        result = report.build_report({'stories': cases})['mailbox_receipt_to_first_published']
        self.assertEqual(result['denominator'], 10)
        self.assertEqual(result['sample_count'], 1)
        self.assertEqual(result['median_seconds'], 120)
        self.assertEqual(result['excluded'], {'no_verified_receipt': 6, 'missing_timestamp': 1, 'malformed_timestamp': 1, 'backwards': 1})
        self.assertNotIn('aaaa', json.dumps(result))

    def test_mailbox_earliest_verified_receipt_includes_coverage(self):
        result = report.build_report({'stories': [{'url': 'https://news.test/a', 'coverage': [{'url': 'https://other.test/a'}],
            'firstPublishedAt': '2026-09-11T14:05:00Z', 'sourceReceipts': [
                {'provider': 'gmail', 'messageHash': 'a' * 64, 'url': 'https://news.test/a', 'receivedAt': '2026-09-11T14:03:00Z'},
                {'provider': 'gmail', 'messageHash': 'b' * 64, 'url': 'https://other.test/a', 'receivedAt': '2026-09-11T14:00:00Z'}]}]})
        self.assertEqual(result['mailbox_receipt_to_first_published']['median_seconds'], 300)

    def test_optional_device_aggregates_are_observations_not_provider_success(self):
        result = report.push_report([{'state': 'retry', 'count': 3,
            'valid_received_latency_count': 2, 'received_latency_sum_seconds': 20,
            'valid_displayed_latency_count': 1, 'displayed_latency_sum_seconds': 12}])
        self.assertEqual(result['device_receipt']['mean_seconds'], 10)
        self.assertEqual(result['device_receipt']['excluded_count'], 1)
        self.assertEqual(result['device_displayed']['mean_seconds'], 12)
        self.assertEqual(result['provider_acceptance']['sample_count'], 0)
        self.assertEqual(report.push_report([{'state': 'sent', 'count': 1}])['device_receipt'], 'unmeasured')
        for bad in ({'valid_received_latency_count': 4, 'received_latency_sum_seconds': 1}, {'valid_received_latency_count': 1}, {'valid_displayed_latency_count': 1, 'displayed_latency_sum_seconds': -1}):
            with self.assertRaises(ValueError):
                report.push_report([{'state': 'sent', 'count': 3, **bad}])

    def test_cli_reads_local_export(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'days.json'
            path.write_text(json.dumps({'stories': []}))
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/report_delivery.py'), str(path)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['stories'], 0)


if __name__ == '__main__':
    unittest.main()
