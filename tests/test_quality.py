import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import check_quality as q

class QualityTests(unittest.TestCase):
    def codes(self, doc, **kwargs):
        return {item['code'] for item in q.check_document(doc, **kwargs)}

    def test_ranking_and_featured_structure(self):
        doc={'stories':[{'id':'a','brief':True,'featured':True},{'id':'b'}]}
        self.assertTrue({'featured_brief','card_after_brief'} <= self.codes(doc))
        self.assertIn('card_capacity', self.codes({'stories':[{'id':str(i)} for i in range(31)]}))

    def test_keypoint_lengths_and_references(self):
        doc={'stories':[{'id':'a','featured':True}], 'keyPoints':[{'id':'missing','text':'word '*31}]}
        self.assertTrue({'keypoint_length','keypoint_reference','featured_keypoint_missing'} <= self.codes(doc))

    def test_quality_checks_never_mutate_documents(self):
        doc={'stories':[{'id':'a','title':'Investors take over the tower','summary':'PRIVATE BODY', 'valueUsd':20}]}
        original=copy.deepcopy(doc)
        issues=q.check_document(doc)
        self.assertEqual(doc,original)
        self.assertNotIn('PRIVATE BODY',json.dumps(issues))
        self.assertTrue({'actor_identification','amount_type_missing'} <= {i['code'] for i in issues})
        self.assertTrue(all(i['severity']=='warning' for i in issues))

    def test_amounts_need_explicit_meaning_and_closed_sale_consistency(self):
        bad={'stories':[{'id':'a','valueUsd':True,'valueType':'salePrice','transactionStatus':'listed'}]}
        self.assertTrue({'amount_number','sale_status_mismatch'} <= self.codes(bad))
        good={'stories':[{'id':'a','valueUsd':20,'valueType':'salePrice','transactionStatus':'closed','transactionId':'stable-sale'}]}
        self.assertNotIn('amount_type_missing',self.codes(good))
        self.assertNotIn('transaction_identity_missing',self.codes(good))

    def test_notifications_validate_explicit_boolean_and_complete_bounded_copy(self):
        doc={'stories':[{'id':'a','pushEligible':'yes'},{'id':'b','pushEligible':True,'pushTitle':'x'*39,'pushBody':'The buyer purchased the property and'}]}
        self.assertTrue({'push_boolean','push_title_length','push_body_fragment'} <= self.codes(doc))
        self.assertIn('push_copy_missing',self.codes({'stories':[{'id':'a','pushEligible':True}]}))

    def test_registry_evidence_and_alias_collisions(self):
        issues=q.check_document({'stories':[]},registries={
            'terms':{'terms':{'cap':{'term':'Cap Rate','aliases':['Capitalization rate']},'cap2':{'term':'Capitalization Rate'}}},
            'events':{'events':{'fed':{'date':'2026-09-11','type':'fed'}}},
            'metrics':{'metrics':{'office':{'unit':'%','series':[{'value':11,'asOf':'2026-09'}]}}}})
        codes={i['code'] for i in issues}
        self.assertTrue({'term_alias_collision','event_official_evidence','metric_population','metric_source'} <= codes)

    def test_cli_summary_does_not_dump_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'day.json';path.write_text(json.dumps({'stories':[{'id':'a','content':'PRIVATE SUBSCRIBER TEXT'}]}))
            before=path.read_bytes()
            result=subprocess.run([sys.executable,str(Path(q.__file__)),str(path)],capture_output=True,text=True)
            self.assertEqual(result.returncode,0)
            self.assertNotIn('PRIVATE SUBSCRIBER TEXT',result.stdout+result.stderr)
            self.assertEqual(before,path.read_bytes())

if __name__=='__main__': unittest.main()
