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
        data = [{'data': {'stories': [{'id': 'private-id', 'content': '<p>' + 'word ' * 120 + '</p>', 'summaryPublishedAt': None}]}}]
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

    def test_cli_reads_local_export(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'days.json'
            path.write_text(json.dumps({'stories': []}))
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/report_delivery.py'), str(path)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['stories'], 0)


if __name__ == '__main__':
    unittest.main()
