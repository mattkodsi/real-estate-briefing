import contextlib
import hashlib
import io
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import trd_session as session

class TicketTests(unittest.TestCase):
    def run_ticket(self, runner):
        output=io.StringIO()
        with patch.dict(os.environ,{},clear=True), patch.object(sys,'argv',['trd_session.py','--issue-ticket','--domain','bisnow.com']), patch.object(session.subprocess,'run',side_effect=runner), patch.object(session.secrets,'token_hex',return_value='a'*64), contextlib.redirect_stdout(output):
            session.issue_ticket()
        return output.getvalue()

    def test_cli_fallback_uses_hash_file_no_shell_and_removes_file(self):
        paths=[]
        def runner(args,**kwargs):
            path=Path(args[args.index('--file')+1]);paths.append(path)
            sql=path.read_text()
            self.assertIn(hashlib.sha256(('a'*64).encode()).hexdigest(),sql)
            self.assertNotIn('a'*64,sql)
            self.assertIn("'bisnow.com'",sql)
            self.assertEqual(kwargs['timeout'],30)
            self.assertFalse(kwargs.get('shell',False))
            self.assertIn('--linked',args)
            self.assertEqual(args[args.index('--project-ref')+1],'uhwdnmbxiopfysodydty')
            return subprocess.CompletedProcess(args,0,json.dumps({'boundary':'fixture','rows':[{'issued':True}],'warning':'untrusted result'}),'')
        output=self.run_ticket(runner)
        self.assertIn('a'*64,output)
        self.assertNotIn(hashlib.sha256(('a'*64).encode()).hexdigest(),output)
        self.assertTrue(all(not p.exists() for p in paths))

    def test_failure_and_malformed_responses_do_not_print_token_or_cli_details(self):
        for result in [subprocess.CompletedProcess([],1,'SECRET CLI OUTPUT','SECRET ERROR'),subprocess.CompletedProcess([],0,'not-json',''),subprocess.CompletedProcess([],0,'{"rows":[{"issued":false}]}',''),subprocess.CompletedProcess([],0,'{"rows":[{"issued":"true"}]}',''),subprocess.CompletedProcess([],0,'[{"issued":true}]','')]:
            paths=[]
            def runner(args,**kwargs):
                paths.append(Path(args[args.index('--file')+1]));return result
            with self.assertRaises(SystemExit) as error:
                self.run_ticket(runner)
            self.assertNotIn('SECRET',str(error.exception));self.assertNotIn('a'*64,str(error.exception))
            self.assertTrue(all(not p.exists() for p in paths))

    def test_timeout_cleans_up_and_preserves_private_cookie_requirement(self):
        paths=[]
        def runner(args,**kwargs):
            paths.append(Path(args[args.index('--file')+1]));raise subprocess.TimeoutExpired(args,30)
        with self.assertRaises(SystemExit):self.run_ticket(runner)
        self.assertTrue(all(not p.exists() for p in paths))
        with patch.dict(os.environ,{},clear=True),self.assertRaises(SystemExit):session.owner_secret()

    def test_existing_private_secret_path_does_not_use_cli(self):
        body={'ok':True,'domain':'therealdeal.com','captureToken':'b'*64}
        response=io.StringIO(json.dumps(body))
        output=io.StringIO()
        with patch.dict(os.environ,{'AUDIT_PIPELINE_SECRET':'fixture-private'},clear=True),patch.object(sys,'argv',['script','--issue-ticket']),patch.object(session.subprocess,'run') as runner,patch.object(session.urllib.request,'urlopen',return_value=response) as request,contextlib.redirect_stdout(output):
            session.issue_ticket()
        runner.assert_not_called()
        self.assertEqual(request.call_args.args[0].get_header('X-audit-secret'),'fixture-private')
        self.assertIn('b'*64,output.getvalue())
        self.assertNotIn('fixture-private',output.getvalue())

    def test_domain_rejected_before_cli(self):
        with patch.dict(os.environ,{},clear=True),patch.object(sys,'argv',['script','--issue-ticket','--domain',"evil');drop table secrets;--"]),patch.object(session.subprocess,'run') as runner,self.assertRaises(SystemExit):session.issue_ticket()
        runner.assert_not_called()

if __name__=='__main__':unittest.main()
