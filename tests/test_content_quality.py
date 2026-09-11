import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from content_quality import assess_content
import fetch_article
import fill_content

PROSE = '<p>The developer acquired the property after a competitive bidding process involving several local firms. The company plans to renovate the existing apartments next year while retaining the ground floor retail space and the current property manager.</p><p>The sale closed on Tuesday after the buyer secured financing from a regional lender. Public records identify the seller as a partnership that bought the building ten years ago and subsequently completed significant improvements.</p>'
SHELL = '<ul>' + '<li>Other market headlines and navigation links</li>' * 30 + '</ul><p>This news story is available exclusively to Example subscribers.</p>'
class QualityTests(unittest.TestCase):
    def test_short_real_body(self):
        self.assertTrue(assess_content(PROSE)['ready'])
        self.assertTrue(fetch_article.extract_from_html('<html><article>'+PROSE+'</article></html>', 'https://example.com/news')['ok'])
    def test_shell_not_ready(self):
        self.assertFalse(assess_content(SHELL)['ready'])
        self.assertFalse(fetch_article.extract_from_html('<html><article>'+SHELL+'</article></html>', 'https://example.com/news')['ok'])
    def test_removed_gate_does_not_certify_teaser(self):
        source = '<article>'+PROSE+'<div class="paywall"><p>Subscribe to continue reading this article.</p></div></article>'
        result = fetch_article.extract_from_html(source, 'https://example.com/news')
        self.assertFalse(result['ok'])
        self.assertEqual(result['qualityReason'], 'subscriber_gate')
    def test_long_headings_not_prose(self):
        self.assertFalse(assess_content('<h2>Market news </h2>' * 100)['ready'])
    def test_gate_invalidates_teaser(self):
        self.assertFalse(assess_content(PROSE+'<p>Subscribe to continue reading this article.</p>')['ready'])
    def test_short_good_replaces_long_bad(self):
        story={'title':'','url':'https://example.com/news','content':SHELL,'image':'image','contentReadyAt':'stale'}
        self.assertTrue(fill_content.needs_enrichment(story))
        with patch.object(fetch_article,'extract',return_value={'ok':True,'html':PROSE,'words':80}):
            self.assertEqual(fill_content._try_story(story)[0],'filled')
        self.assertEqual(story['content'],PROSE)
    def test_failed_fetch_keeps_good_body(self):
        story={'url':'https://example.com/news','content':PROSE}
        with patch.object(fetch_article,'extract',return_value={'ok':False,'words':0}): fill_content._try_story(story)
        self.assertEqual(story['content'],PROSE)
    def test_missing_not_assumed_expired_login(self):
        res=fetch_article.extract_from_html('<html><article><p>Short snippet.</p></article></html>','https://therealdeal.com/news')
        self.assertFalse(res.get('paywalled',False))
    def test_alternate_recovery_preserves_attribution(self):
        story={'title':'Development sale closes','url':'https://primary.example/news','publisher':'Primary Desk','content':None,'coverage':[{'url':'https://alternate.example/report','publisher':'Alternate Desk','title':'Development sale closes'}]}
        responses=[{'ok':False,'words':0},{'ok':True,'html':PROSE,'words':80,'title':'Development sale closes','image':'https://alternate.example/image.jpg'}]
        with patch.object(fetch_article,'extract',side_effect=responses) as call:
            self.assertEqual(fill_content._try_story(story)[0],'filled')
        self.assertEqual(story['url'],'https://alternate.example/report')
        self.assertEqual(story['publisher'],'Alternate Desk')
        self.assertEqual(story['title'],'Development sale closes')
        self.assertEqual(story['coverage'][0]['publisher'],'Primary Desk')
        self.assertEqual(story['coverage'][0]['url'],'https://primary.example/news')
    def test_no_promotion_of_gated_coverage(self):
        story={'url':'https://primary.example/news','coverage':[{'url':'https://alternate.example/news'}]}
        with patch.object(fetch_article,'extract',return_value={'ok':False,'words':200,'html':SHELL}):
            self.assertEqual(fill_content._try_story(story)[0],'failed')
        self.assertEqual(story['url'],'https://primary.example/news')
    def test_missing_primary_can_use_existing_coverage(self):
        story={'coverage':[{'url':'https://alternate.example/news','publisher':'Alternate Desk'}]}
        self.assertTrue(fill_content.needs_enrichment(story))
        with patch.object(fetch_article,'extract',return_value={'ok':True,'html':PROSE,'words':80}):
            self.assertEqual(fill_content._try_story(story)[0],'filled')
        self.assertEqual(story['publisher'],'Alternate Desk')
    def test_browser_explicit_null_primary_recovers_and_clears_error(self):
        import fill_browser
        from unittest.mock import MagicMock
        story={'id':'test','title':'Development sale closes','url':None,'publisher':'Original','content':None,'fillError':'prior_failure','coverage':[{'url':'https://alternate.example/news','publisher':'Alternate'}]}
        day={'date':'2026-09-11','stories':[story]}
        with patch.object(fill_content,'load_day',return_value=(day,MagicMock())), patch.object(fill_content,'DATA',MagicMock()), patch.object(fill_browser,'_cookies_for',return_value=[]), patch.object(fill_browser,'fetch_with_browser',side_effect=RuntimeError('primary unavailable')), patch.object(fetch_article,'extract',return_value={'ok':True,'html':PROSE,'words':80,'title':'Development sale closes'}):
            self.assertEqual(fill_browser._fill_one_day(MagicMock(),MagicMock(),set(),'2026-09-11',True),(1,0))
        self.assertEqual(story['publisher'],'Alternate')
        self.assertEqual(story['url'],'https://alternate.example/news')
        self.assertNotIn('fillError',story)
        self.assertEqual(story['contentStatus'],'ready')
        self.assertEqual(fill_content._host(None),'')
        self.assertFalse(fetch_article.is_fabricated_bisnow_shortlink(None))
    def test_python_js_policy_parity(self):
        fixtures=[None,'',PROSE,SHELL,'<h2>News </h2>'*100,PROSE+'<p>Subscribe to continue reading.</p>']
        script="import {assessContent} from './supabase/functions/_shared/content-quality.mjs'; console.log(JSON.stringify(JSON.parse(process.argv[1]).map(assessContent)))"
        js=json.loads(subprocess.check_output(['node','--input-type=module','-e',script,json.dumps(fixtures)],text=True,cwd=Path(__file__).resolve().parents[1]))
        self.assertEqual(js,[assess_content(f) for f in fixtures])
if __name__=='__main__': unittest.main()
