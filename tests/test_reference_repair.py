import copy
import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from reference_repair import apply_manifest, reviewed_unavailable, validate_registry_references, validate_known_identity_conflicts
from report_research_quality import build_report

class ReferenceRepairTests(unittest.TestCase):
    def setUp(self):
        self.old = {'date':'2026-01-01','id':'old','title':'Old','role':'buyer'}
        self.new = {**self.old,'id':'new'}
        self.days = {'2026-01-01':{'date':'2026-01-01','stories':[{'id':'new','title':'New','url':'https://example.test/a'}]}}
        self.reg = {'players':{'a':{'mentions':[self.old]}}}
        self.op = {'kind':'reference','table':'players','key':'a','location':'mentions[0]','old':self.old,'new':self.new,'target':{'date':'2026-01-01','id':'new','title':'New','url':'https://example.test/a'}}
    def test_known_identity_guard_is_narrow(self):
        story={'content':'MF1 partner Berkshire Residential Investments', 'title':'MF1 sells to Berkshire Hathaway'}
        self.assertTrue(validate_known_identity_conflicts(story))
        story['title']='MF1 sells to Berkshire Residential Investments'
        self.assertEqual(validate_known_identity_conflicts(story),[])
        self.assertEqual(validate_known_identity_conflicts({'content':'Different deal','title':'Berkshire Hathaway'}),[])
    def test_cas_preserves_input_and_all_other_fields(self):
        result=apply_manifest(self.reg,self.days,{'operations':[self.op]})
        self.assertEqual(result['players']['a']['mentions'][0]['role'],'buyer')
        self.assertEqual(self.reg['players']['a']['mentions'][0]['id'],'old')
    def test_stale_full_reference_not_just_id_rejected(self):
        self.reg['players']['a']['mentions'][0] = {**self.old,'role':'seller'}
        with self.assertRaises(ValueError): apply_manifest(self.reg,self.days,{'operations':[self.op]})
    def test_target_title_changed_rejected(self):
        self.days['2026-01-01']['stories'][0]['title']='Other event'
        with self.assertRaises(ValueError): apply_manifest(self.reg,self.days,{'operations':[self.op]})
    def test_target_and_new_mismatch_rejected(self):
        self.op['new']={**self.new,'id':'other'}
        with self.assertRaises(ValueError): apply_manifest(self.reg,self.days,{'operations':[self.op]})
    def test_unavailable_requires_complete_original_and_evidence(self):
        ref={**self.old,'referenceReview':{'status':'unavailable','reviewedAt':'2026-09-11','evidence':'Checked complete archive; source absent','original':copy.deepcopy(self.old)}}
        self.assertTrue(reviewed_unavailable(ref))
        self.assertEqual(validate_registry_references('players',{'mentions':[ref]},{}),[])
        ref['role']='seller'
        self.assertFalse(reviewed_unavailable(ref))
        self.assertTrue(validate_registry_references('players',{'mentions':[ref]},{}))
    def test_reports_reviewed_unavailable_without_hiding_total(self):
        ref={**self.old,'referenceReview':{'status':'unavailable','reviewedAt':'2026-09-11','evidence':'Archive reviewed','original':self.old}}
        report=build_report(list(self.days.values()),{'players':{'a':{'mentions':[ref]}}})
        self.assertEqual(report['reference_issue_counts'],{'unreviewed':0,'reviewed_unavailable':1,'total_unresolved':1})
    def test_person_company_same_alias_is_relationship(self):
        report=build_report([],{'players':{'person':{'type':'person','name':'Person','aliases':['RFR']},'company':{'type':'company','name':'RFR'}}})
        self.assertEqual(report['duplicate_candidates'],[])
        self.assertEqual(len(report['identity_relationships']),1)
    def test_campaign_and_missing_day_fail_closed(self):
        self.assertEqual(validate_registry_references('campaigns',{'branches':[{'stories':[self.old]}]},{}),[{'location':'branches[0].stories[0]','reason':'day_unavailable'}])
    def test_persisted_distinct_review_survives_alias_cleanup(self):
        review={'keys':['a','b'],'decision':'distinct_related','reviewedAt':'2026-09-11','evidence':'Broader versus narrower concept'}
        report=build_report([],{'terms':{'a':{'term':'Net Lease','researchReviews':[review]},'b':{'term':'NNN Lease'}}})
        self.assertEqual(len(report['reviewed_identity_decisions']),1)

if __name__=='__main__':unittest.main()
