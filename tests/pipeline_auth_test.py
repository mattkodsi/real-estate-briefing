import importlib.util
import pathlib
import unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1]
def load(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/f'{name}.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
class PipelineAuthTest(unittest.TestCase):
    def test_proxy_attaches_server_only_secret(self):
        m=load('fetch_article')
        class Response:
            def __enter__(self): return self
            def __exit__(self,*args): pass
            def read(self): return b'{"ok":true,"html":"test","finalUrl":"https://news.test"}'
        requests=[]
        def send(req,**kwargs):requests.append(req);return Response()
        with patch.dict('os.environ',{'AUDIT_PIPELINE_SECRET':'test-secret'}),patch('urllib.request.urlopen',send):
            m._fetch_via_proxy('https://news.test')
        self.assertEqual(requests[0].get_header('X-audit-secret'),'test-secret')
    def test_notification_secret_does_not_leak_to_table_writes(self):
        m=load('monitor_sources');requests=[]
        class Response:
            def read(self): return b'{}'
        with patch.dict('os.environ',{'AUDIT_PIPELINE_SECRET':'test-secret'}),patch('urllib.request.urlopen',lambda req,**kw:(requests.append(req) or Response())):
            m._post('functions/v1/push-send',{'title':'test'})
            m._post('rest/v1/app_status',{})
        self.assertEqual(requests[0].get_header('X-audit-secret'),'test-secret')
        self.assertIsNone(requests[1].get_header('X-audit-secret'))
if __name__=='__main__':unittest.main()
