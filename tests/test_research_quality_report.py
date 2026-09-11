import copy
import importlib.util
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from report_research_quality import build_report

class ResearchQualityReportTests(unittest.TestCase):
    def test_alias_candidates_are_not_semantic_merges(self):
        result = build_report([], {'players': {'a': {'name': 'ACME, Inc.'}, 'b': {'name': 'Different', 'aliases': ['acme inc']}, 'c': {'name': 'ACME Capital'}}})
        self.assertEqual(len(result['duplicate_candidates']), 1)
        self.assertEqual(result['duplicate_candidates'][0]['keys'], ['a', 'b'])
        self.assertEqual(result['duplicate_candidates'][0]['status'], 'candidate_only')

    def test_reference_date_and_partial_export(self):
        days = [{'date': '2026-09-01', 'stories': [{'id': 'one', 'featured': True}]}]
        regs = {'threads': {'x': {'title': 'X', 'entries': [{'date': '2026-09-01', 'id': 'one'}, {'date': '2026-09-01', 'id': 'gone'}, {'date': '2026-08-01', 'id': 'one'}]}}}
        result = build_report(days, regs)
        self.assertEqual([x['reason'] for x in result['reference_findings']], ['story_absent', 'day_not_exported'])

    def test_campaign_nested_references_and_repeat(self):
        ref = {'date': '2026-09-01', 'id': 'one'}
        result = build_report([{'date': ref['date'], 'stories': [{'id': 'one'}]}], {'campaigns': {'c': {'branches': [{'stories': [ref, ref]}], 'relatedThreads': ['missing']}}})
        self.assertEqual(result['reference_counts']['campaigns'], 2)
        self.assertEqual(result['repeated_references'][0]['count'], 2)
        self.assertEqual(result['registry_reference_findings'][0]['target_key'], 'missing')

    def test_no_prose_or_urls_and_no_mutation(self):
        days = [{'date': '2026-09-01', 'stories': [{'id': 'x', 'content': 'SECRET', 'url': 'https://example.com/roundup', 'valueUsd': 5}, {'id': 'y', 'url': 'https://example.com/roundup'}]}]
        saved = copy.deepcopy(days)
        result = build_report(days, {})
        self.assertEqual(days, saved)
        self.assertNotIn('SECRET', str(result))
        self.assertNotIn('https://', str(result))
        self.assertEqual(result['duplicate_candidates'], [])
        self.assertEqual(result['quality_counts']['amount_type_missing'], 1)

    def test_resolved_term_alias_not_an_unresolved_duplicate(self):
        result = build_report([], {'terms': {'a': {'term': 'Example'}, 'b': {'term': 'Example', 'aliasOf': 'a'}}})
        self.assertEqual(result['duplicate_candidates'], [])
        self.assertEqual(result['resolved_aliases'], [{'table': 'terms', 'key': 'b', 'target_key': 'a'}])
        self.assertNotIn('term_alias_collision', result['quality_counts'])

    def test_dangling_alias_and_chain_are_reported(self):
        result = build_report([], {'terms': {'a': {'aliasOf': 'b'}, 'b': {'aliasOf': 'gone'}}})
        self.assertEqual(result['resolved_aliases'], [])
        refs = result['registry_reference_findings']
        self.assertEqual([(r['key'], r['reason'], r['target_key']) for r in refs],
                         [('a', 'target_absent', 'gone'), ('b', 'target_absent', 'gone')])

    def test_alias_cycles_include_self_and_upstream(self):
        result = build_report([], {'terms': {'a': {'aliasOf': 'b'}, 'b': {'aliasOf': 'a'},
                                            'c': {'aliasOf': 'a'}, 'self': {'aliasOf': 'self'}}})
        self.assertEqual(result['resolved_aliases'], [])
        self.assertEqual({r['key'] for r in result['registry_reference_findings']}, {'a', 'b', 'c', 'self'})
        self.assertTrue(all(r['reason'] == 'alias_cycle' for r in result['registry_reference_findings']))

    def test_valid_chain_does_not_claim_consumer_resolves_it(self):
        result = build_report([], {'terms': {'a': {'aliasOf': 'b'}, 'b': {'aliasOf': 'c'}, 'c': {'term': 'C'}}})
        self.assertEqual(result['resolved_aliases'], [{'table': 'terms', 'key': 'b', 'target_key': 'c'}])
        self.assertEqual(result['registry_reference_findings'][0]['reason'], 'alias_chain')

    def test_registry_checks_run_once_and_internal_rows_excluded(self):
        result = build_report([{'date': 'a', 'stories': []}, {'date': 'b', 'stories': []}], {'players': {'_candidates': {'names': {}}}, 'terms': {'a': {'term': 'A'}, 'b': {'term': 'a'}}})
        self.assertEqual(result['quality_counts']['term_alias_collision'], 1)
        self.assertEqual(result['registry_counts']['players'], 0)

if __name__ == '__main__':
    unittest.main()
