import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from editorial_quality import prepare_editorial
import publication

class ThreadReviewGuardTests(unittest.TestCase):
    def current(self,status='unavailable'):
        review={'status':status,'reviewedAt':'2026-09-11','original':{'date':'2026-09-01','id':'a','thread':'missing'},'evidence':'Reviewed archive: original thread absent'}
        story={'id':'a','title':'Story','threadReview':review}
        if status=='resolved':story['thread']='correct';review['target']='correct'
        return {'date':'2026-09-01','generatedAt':'2026-09-11T12:00:00Z','stories':[story]}
    def test_omitted_resolved_thread_and_review_are_restored(self):
        current=self.current('resolved');incoming={'date':'2026-09-01','stories':[{'id':'a','title':'New'}]}
        story=prepare_editorial(incoming,current)['stories'][0]
        self.assertEqual(story['thread'],'correct');self.assertEqual(story['threadReview'],current['stories'][0]['threadReview'])
    def test_old_missing_target_explicitly_reintroduced_is_blocked(self):
        for status in ['unavailable','resolved']:
            with self.subTest(status=status),self.assertRaises(ValueError):
                prepare_editorial({'date':'2026-09-01','stories':[{'id':'a','title':'New','thread':'missing'}]},self.current(status))
    def test_unavailable_omission_preserves_review_and_no_route(self):
        result=prepare_editorial({'date':'2026-09-01','stories':[{'id':'a','title':'New'}]},self.current())
        self.assertNotIn('thread',result['stories'][0]);self.assertEqual(result['stories'][0]['threadReview']['status'],'unavailable')
    def test_stale_generator_cannot_drop_review_by_empty_marker(self):
        with self.assertRaises(ValueError):prepare_editorial({'date':'2026-09-01','stories':[{'id':'a','title':'New','threadReview':{}}]},self.current())
    def test_unrelated_same_batch_new_thread_still_allowed(self):
        incoming={'date':'2026-09-01','generatedAt':'2026-09-11T13:00:00Z','stories':[{'id':'new','title':'New story','thread':'created-later-in-batch'}]}
        class Fake:
            def __init__(self):self.calls=[]
            def read(self,table,key):self.calls.append((table,key));return None
            def compare_swap(self,*args):return True
        client=Fake();publication.publish_document('days','2026-09-01',incoming,client)
        self.assertEqual(client.calls,[('days','2026-09-01')])
    def test_guard_rejects_through_actual_publication(self):
        current=self.current();incoming=copy.deepcopy(current);incoming['generatedAt']='2026-09-11T13:00:00Z';incoming['stories'][0]['thread']='missing';incoming['stories'][0].pop('threadReview')
        class Fake:
            def read(self,*args):return current
            def compare_swap(self,*args):raise AssertionError('must not write')
        with self.assertRaises(ValueError):publication.publish_document('days','2026-09-01',incoming,Fake())

if __name__=='__main__':unittest.main()
