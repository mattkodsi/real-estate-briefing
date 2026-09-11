import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from editorial_quality import prepare_editorial, validate_claims
class EditorialQualityTests(unittest.TestCase):
 def test_evidence_objects_pass_document_validation_but_invalid_amounts_do_not(self):
  import copy, publication as p
  doc={'date':'2026-09-11','generatedAt':'2026-09-11T18:00:00Z','stories':[{'id':'a','valueUsd':1250000000,
    'fieldEvidence':{'valueUsd':{'value':1250000000,'quote':'$1.25 billion financing','url':'https://example.com/a'}}}]}
  p.validate_document('days',doc)
  validate_claims(doc['stories'][0])
  bad=copy.deepcopy(doc);bad['stories'][0]['valueUsd']='1250000000'
  with self.assertRaisesRegex(ValueError,'valueUsd'):p.validate_document('days',bad)
  bad=copy.deepcopy(doc);bad['stories'][0]['fieldEvidence']['valueUsd']['url']='javascript:alert(1)'
  with self.assertRaisesRegex(ValueError,'HTTP'):p.validate_document('days',bad)
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

class EditorialRestorationTests(unittest.TestCase):
 def test_restored_body_rejects_mf1_headline_conflict(self):
  import copy, publication as p
  body=('<p>Berkshire Residential Investments acquired the remaining ownership stake in MF1 from Limekiln Real Estate. '
        'The transaction consolidates ownership of the lending platform under the buyer following several years of joint operations. '
        'The platform provides financing for apartment properties across the country and will continue serving existing borrowers.</p>'
        '<p>The seller said its investment supported the growth of the platform over the holding period. '
        'The announcement did not disclose a purchase price or indicate changes to the outstanding loans.</p>')
  current={'stories':[{'id':'mf1','url':'https://example.com/mf1','title':'Berkshire Residential Investments buys MF1 stake','content':body}]}
  incoming=copy.deepcopy(current)
  del incoming['stories'][0]['content']
  incoming['stories'][0]['title']='Berkshire Hathaway buys MF1'
  self.assertTrue(p.assess_content(body)['ready'],'fixture must reach the body restoration path')
  self.assertNotIn('content',prepare_editorial(incoming,current)['stories'][0],
                   'the initial copy-only validation has no source body to compare')
  with self.assertRaisesRegex(ValueError,'Source/entity mismatch'):
   p.stamp_editorial(incoming,current,'2026-09-11T18:00:00Z')
  self.assertNotIn('content',incoming['stories'][0],'validation must not mutate the draft')

 def test_omitted_receipts_preserve_only_current_primary_and_coverage_sources(self):
  import copy, publication as p
  primary='https://example.com/primary'; alternate='https://alternate.example/article'; removed='https://removed.example/article'
  receipts=[{'provider':'gmail','receivedAt':'2026-09-11T10:00:00Z','messageHash':str(i)*64,'url':url}
            for i,url in enumerate((primary,alternate,removed),1)]
  current={'stories':[{'id':'a','title':'Property sale closes','url':primary,
                       'coverage':[{'url':alternate},{'url':removed}],'sourceReceipts':receipts}]}
  incoming=copy.deepcopy(current)
  del incoming['stories'][0]['sourceReceipts']
  incoming['stories'][0]['coverage']=[{'url':alternate}]
  result=p.stamp_editorial(incoming,current,'2026-09-11T18:00:00Z')
  self.assertEqual(result['stories'][0]['sourceReceipts'],receipts[:2])
  self.assertNotIn('sourceReceipts',incoming['stories'][0])
  result['stories'][0]['sourceReceipts'][0]['receivedAt']='changed'
  self.assertEqual(current['stories'][0]['sourceReceipts'][0]['receivedAt'],'2026-09-11T10:00:00Z')
