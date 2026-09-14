#!/usr/bin/env python3
"""Private, best-effort pipeline timeline with a durable local replay spool.

Use `begin`, `event`, `end`, `run`, `flush`, and `report` for external routines.
Observed time is captured here; database recorded_at is assigned independently.
No source text, URLs, credentials, or exception messages belong in this log.
"""
import argparse
from contextlib import contextmanager, nullcontext
from contextvars import ContextVar
from datetime import datetime, timezone
from functools import wraps
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid

ENDPOINT = 'https://uhwdnmbxiopfysodydty.supabase.co/functions/v1/pipeline-trace'
_ACTIVE = ContextVar('pipeline_trace', default=None)
_ENTITY = ContextVar('pipeline_trace_entity', default=(None,None))
_SPAN = ContextVar('pipeline_trace_span', default=None)
EXECUTION_KEYS = {'executor','environment','method','provider','model','workflow','artifact_type','artifact_hash','input_hash','trigger','retry_reason'}
TEXT_KEYS = {'error_type','mode','phase','git_sha','external_run_id','parent_run_id',
             'source_hash','receipt_at','span_id','parent_span_id','reason'}
TEXT_KEYS |= EXECUTION_KEYS
NUMBER_KEYS = {'count','filled','failed','attempt','duration_ms','skipped','attempted','words','exit_code'}
IDENTIFIER = re.compile(r'^[A-Za-z0-9_.:/-]{1,200}$')


def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')


def warn(message):
    try:
        print('TRACE WARNING: '+message, file=sys.stderr)
    except Exception:
        pass


def clean_details(details):
    result = {}
    for key, value in (details or {}).items():
        if key in TEXT_KEYS and isinstance(value,str) and len(value)<=200:
            if key == 'receipt_at':
                try:
                    if datetime.fromisoformat(value.replace('Z','+00:00')).tzinfo is None: continue
                except ValueError: continue
            elif not IDENTIFIER.fullmatch(value) or '://' in value: continue
            result[key]=value
        elif key in NUMBER_KEYS and isinstance(value,(int,float)) and not isinstance(value,bool):
            if -1 <= value <= 10**12 and value == value: result[key]=value
    return result


def spool_directory():
    return Path(os.environ.get('BRIEFING_TRACE_DIR') or Path(__file__).resolve().parents[1]/'data'/'pipeline-trace')


def headers():
    run=_ACTIVE.get()
    return {'x-briefing-run-id':run.run_id,'x-briefing-producer':run.producer} if run else {}


def send(events):
    secret=os.environ.get('AUDIT_PIPELINE_SECRET')
    if not secret: return False
    request=urllib.request.Request(ENDPOINT, data=json.dumps({'events':events}).encode(),
        headers={'Content-Type':'application/json','x-audit-secret':secret},method='POST')
    with urllib.request.urlopen(request,timeout=3) as response:
        return 200 <= response.status < 300


def pending_events(path):
    path=Path(path)
    ack=path.with_suffix('.acked')
    acknowledged=set(ack.read_text().splitlines()) if ack.exists() else set()
    events=[]
    for line in path.read_text().splitlines():
        try: event=json.loads(line)
        except json.JSONDecodeError:
            warn('incomplete local event line; inspect the spool before removing it')
            continue
        if event['id'] not in acknowledged: events.append(event)
    return events


def append(path, text):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    fd=os.open(path, os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
    with os.fdopen(fd,'a') as stream:
        stream.write(text+'\n')
        stream.flush()
        os.fsync(stream.fileno())


def flush_file(path, transport=send, max_batches=10):
    try:
        pending=pending_events(path)
        for offset in range(0,min(len(pending),max_batches*100),100):
            batch=pending[offset:offset+100]
            if not transport(batch):
                warn('remote log unavailable; events retained locally for replay')
                return False
            append(Path(path).with_suffix('.acked'),'\n'.join(e['id'] for e in batch))
        return len(pending)<=max_batches*100
    except Exception:
        warn('log upload failed; retained local events are safe to replay')
        return False


class Run:
    def __init__(self,producer,run_id=None,directory=None,transport=None,context=None):
        self.producer=producer if IDENTIFIER.fullmatch(producer) else 'unknown'
        supplied=run_id or os.environ.get('BRIEFING_RUN_ID')
        try:
            self.run_id=str(uuid.UUID(supplied)) if supplied else str(uuid.uuid4())
        except (ValueError,AttributeError):
            warn('invalid run correlation ID; assigned a new ID')
            self.run_id=str(uuid.uuid4())
        self.path=Path(directory or spool_directory()) / (self.run_id+'-'+str(uuid.uuid4())+'.jsonl')
        self.transport=transport or send
        self.result='completed'
        self.context=clean_details({
            'executor':'github-actions' if os.environ.get('GITHUB_ACTIONS')=='true' else os.environ.get('BRIEFING_EXECUTOR','local-process'),
            'environment':sys.platform,
            'workflow':os.environ.get('GITHUB_JOB',''),
            'trigger':os.environ.get('GITHUB_EVENT_NAME',''),
            **(context or {})})
        self.process_span=str(uuid.uuid4())

    def emit(self,stage,status,entity_type=None,entity_key=None,details=None):
        try:
            inherited_type,inherited_key=_ENTITY.get()
            entity_type=entity_type or inherited_type
            entity_key=entity_key or inherited_key
            for value in (stage,status,entity_type,entity_key):
                if value is not None and (not IDENTIFIER.fullmatch(str(value)) or '://' in str(value)):
                    raise ValueError('invalid identifier')
            event={'id':str(uuid.uuid4()),'observed_at':now(),'run_id':self.run_id,
                   'producer':self.producer,'stage':stage,'status':status,
                   'entity_type':entity_type,'entity_key':entity_key,'details':clean_details({**self.context,**(details or {})})}
            append(self.path,json.dumps(event,allow_nan=False))
            return event['id']
        except Exception:
            warn('could not save an event; this run has a logging coverage gap')
            return None

    def flush(self):
        try:
            return flush_file(self.path,self.transport) if self.path.exists() else True
        except Exception:
            warn('local log unavailable; processing will continue')
            return False

    def __enter__(self):
        self.token=_ACTIVE.set(self)
        self.started=time.monotonic()
        self.emit('process','started',details={'span_id':self.process_span,'git_sha':os.environ.get('GITHUB_SHA',''),
            'external_run_id':os.environ.get('GITHUB_RUN_ID','')})
        self.flush()  # makes a subsequent abrupt process death visible as unfinished
        return self

    def __exit__(self,typ,value,tb):
        try:
            self.emit('process','failed' if typ and not (typ is SystemExit and value.code in (None,0)) else self.result,
                details={'span_id':self.process_span,'error_type':typ.__name__ if typ else '',
                         'duration_ms':round((time.monotonic()-self.started)*1000)})
            self.flush()
        finally:
            _ACTIVE.reset(self.token)
        return False

    @contextmanager
    def phase(self,stage,entity_type=None,entity_key=None,details=None):
        span=str(uuid.uuid4()); started=time.monotonic()
        inherited_type,inherited_key=_ENTITY.get()
        entity_type,entity_key=entity_type or inherited_type,entity_key or inherited_key
        token=_ENTITY.set((entity_type,entity_key))
        parent=_SPAN.get()
        span_token=_SPAN.set(span)
        info={**(details or {}),'span_id':span,'parent_span_id':parent or self.process_span}
        self.emit(stage,'started',entity_type,entity_key,info)
        try:
            yield
        except BaseException as exc:
            self.emit(stage,'failed',entity_type,entity_key,{**info,'error_type':type(exc).__name__,
                'duration_ms':round((time.monotonic()-started)*1000)})
            raise
        else:
            self.emit(stage,'completed',entity_type,entity_key,{**info,
                'duration_ms':round((time.monotonic()-started)*1000)})
        finally:
            _ENTITY.reset(token)
            _SPAN.reset(span_token)


def emit(stage,status,**kwargs):
    run=_ACTIVE.get()
    return run.emit(stage,status,**kwargs) if run else None


def phase(stage,**kwargs):
    run=_ACTIVE.get()
    return run.phase(stage,**kwargs) if run else nullcontext()


def flush():
    run=_ACTIVE.get()
    return run.flush() if run else True


def outcome(status):
    run=_ACTIVE.get()
    if run and run.result!='failed': run.result=status


def traced_main(producer):
    def decorate(fn):
        @wraps(fn)
        def wrapped(*args,**kwargs):
            with Run(producer) as run:
                result=fn(*args,**kwargs)
                if isinstance(result,int) and result!=0: run.result='failed'
                return result
        return wrapped
    return decorate


def traced(stage,method=None):
    def decorate(fn):
        @wraps(fn)
        def wrapped(*args,**kwargs):
            with phase(stage,details={'method':method}):
                result=fn(*args,**kwargs)
                if isinstance(result,dict) and isinstance(result.get('ok'),bool):
                    emit(stage+'.result','completed' if result['ok'] else 'failed',details={'method':method,'words':result.get('words',0)})
                return result
        return wrapped
    return decorate


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='command',required=True)
    for name in ('begin','event','end','run'):
        p=sub.add_parser(name)
        p.add_argument('--run-id')
        p.add_argument('--producer',default='newsletter-routine')
        p.add_argument('--executor');p.add_argument('--method');p.add_argument('--provider');p.add_argument('--model')
        if name=='event':
            p.add_argument('--stage',required=True)
            p.add_argument('--status',choices=['started','completed','failed','skipped','conflict','degraded'],required=True)
            p.add_argument('--entity-type');p.add_argument('--entity-key')
            p.add_argument('--source-hash');p.add_argument('--receipt-at')
        if name=='end': p.add_argument('--status',choices=['completed','failed','degraded'],required=True)
        if name=='run': p.add_argument('args',nargs=argparse.REMAINDER)
    sub.add_parser('flush')
    p=sub.add_parser('report');p.add_argument('--run-id');p.add_argument('--entity-type');p.add_argument('--entity-key');p.add_argument('--since');p.add_argument('--limit',type=int,default=500);p.add_argument('--cursor');p.add_argument('--format',choices=['text','json'],default='text')
    args=parser.parse_args()
    if args.command=='flush':
        ok=True
        for path in spool_directory().glob('*.jsonl'): ok=flush_file(path) and ok
        return 0 if ok else 1
    if args.command=='report':
        secret=os.environ.get('AUDIT_PIPELINE_SECRET')
        if not secret: parser.error('AUDIT_PIPELINE_SECRET is required to read the private report')
        query=urllib.parse.urlencode({k:v for k,v in vars(args).items() if k not in ('command','format') and v is not None})
        req=urllib.request.Request(ENDPOINT+'?'+query,headers={'x-audit-secret':secret})
        with urllib.request.urlopen(req,timeout=10) as response: report=json.load(response)
        if args.format=='json': print(json.dumps(report,indent=2))
        else:
            for event in report.get('events',[]):
                print(f"{event['recorded_at']} | {event['source']} | {event['producer']} | {event['stage']} {event['status']} | {event.get('entity_type','')}/{event.get('entity_key','')} | observed={event.get('observed_at') or 'database-only'} | {json.dumps(event.get('details',{}))}")
            if report.get('next_cursor'): print('NEXT CURSOR: '+report['next_cursor'])
        return 0
    run=Run(args.producer,args.run_id,context={k:getattr(args,k) for k in ('executor','method','provider','model') if getattr(args,k)})
    if args.command=='run':
        command=args.args[1:] if args.args[:1]==['--'] else args.args
        if not command: parser.error('run requires a command after --')
        with run:
            env={**os.environ,'BRIEFING_RUN_ID':run.run_id}
            result=subprocess.run(command,env=env).returncode
            run.result='completed' if result==0 else 'failed'
        return result
    if args.command!='begin' and not args.run_id: parser.error('--run-id is required')
    if args.command=='begin': run.emit('routine','started')
    elif args.command=='end': run.emit('routine',args.status)
    else:
        if args.stage=='email.read' and (not args.source_hash or not re.fullmatch('[a-f0-9]{64}',args.source_hash)):
            parser.error('email.read requires --source-hash with a SHA-256 of the actual Gmail message ID')
        run.emit(args.stage,args.status,entity_type=args.entity_type,entity_key=args.entity_key,
            details={'source_hash':args.source_hash,'receipt_at':args.receipt_at})
    run.flush()
    print(run.run_id)
    return 0


if __name__=='__main__':
    raise SystemExit(main())
