import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from editorial_quality import prepare_editorial, validate_claims
class EditorialQualityTests(unittest.TestCase):
 def test_buyer_conflict_blocks_publication(self):
  s={'title':'Berkshire Hathaway buys MF1','summary':'Warren Buffett expands lending.','content':'<p>Limekiln sold its stake to Berkshire Residential Investments.</p>'}
  with self.assertRaisesRegex(ValueError,'entity'):validate_claims(s)
 def test_retained_precise_evidence_blocks_reintroduced_wrong_number(self):
  s={'valueUsd':1300000000,'fieldEvidence':{'valueUsd':{'value':1250000000,'quote':'$1.25 billion financing','url':'https://example.com/a'}}}
  with self.assertRaisesRegex(ValueError,'valueUsd'):validate_claims(s)
 def test_no_truncation_and_copy_refresh(self):
  old={'stories':[{'id':'a','title':'Old title','summary':'Old summary','quickSummary':'Old quick line'}]}
  s=prepare_editorial({'stories':[{'id':'a','title':'New title','summary':'New summary','quickSummary':'Old quick line'}]},old)['stories'][0]
  self.assertEqual(s['quickSummary'],'New title')
 def test_receipt_requires_provenance(self):
  with self.assertRaisesRegex(ValueError,'receipt'):validate_claims({'sourceReceipts':[{'receivedAt':'2026-09-11T10:00:00Z'}]})

class EnrichmentGuards(unittest.TestCase):
 def test_changed_publisher_rejects_stale_body(self):
  import copy,publication as p
  base={'date':'2026-09-11','stories':[{'id':'a','url':'https://example.com/a','publisher':'Old'}]}
  edited=copy.deepcopy(base);edited['stories'][0]['content']='<p>New fetched body.</p>'
  current=copy.deepcopy(base);current['stories'][0]['publisher']='Corrected'
  self.assertEqual(p.merge_enrichment(base,edited,current,'test','now'),current)
 def test_fetched_source_cannot_validate_wrong_company(self):
  import copy,publication as p
  base={'date':'2026-09-11','stories':[{'id':'a','title':'Berkshire Hathaway buys MF1','url':'https://example.com/a'}]}
  edited=copy.deepcopy(base);edited['stories'][0]['content']='<p>Limekiln sold its stake to Berkshire Residential Investments.</p>'
  with self.assertRaisesRegex(ValueError,'entity'):p.merge_enrichment(base,edited,base,'test','now')
