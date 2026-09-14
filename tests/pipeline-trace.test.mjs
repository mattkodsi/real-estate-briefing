import test from 'node:test';
import assert from 'node:assert/strict';
import {createPipelineTrace, sanitizeEvent, bounded} from '../supabase/functions/_shared/pipeline-trace.mjs';

test('trace failures and stalled writes never escape into pipeline behavior',async()=>{
 const warnings=[];
 for(const sb of [async()=>{throw Error('secret-body');},()=>new Promise(()=>{})]) {
  const trace=createPipelineTrace({sb,producer:'supabase-edge',timeoutMs:10,warn:x=>warnings.push(x)});
  await trace.emit('run','started',{entity_type:'day',entity_key:'2026-09-14'});
 }
 assert.equal(warnings.length,2);assert.ok(warnings.every(x=>!x.includes('secret-body')));
});
test('metadata allowlist removes bodies, addresses, tokens and arbitrary exception text',()=>{
 const event=sanitizeEvent({id:crypto.randomUUID(),observed_at:new Date().toISOString(),run_id:'run-1',producer:'supabase-edge',stage:'run',status:'started',entity_type:'day',entity_key:'2026-09-14',details:{count:2,body:'secret',url:'https://secret',error:'token',reason:'https://secret',duration_ms:42}});
 assert.deepEqual(event.details,{count:2,duration_ms:42});
 assert.throws(()=>sanitizeEvent({...event,run_id:'https://secret'}));
});
test('execution routes and artifact hashes survive sanitizing and emitter overrides',async()=>{
 const detail={executor:'github-actions',environment:'ubuntu',method:'playwright',provider:'anthropic',model:'model-id',workflow:'fill-content',artifact_type:'day-json',artifact_hash:'a'.repeat(64),input_hash:'b'.repeat(64),source_hash:'c'.repeat(64),trigger:'schedule',retry_reason:'bot_wall',words:512,filled:2,failed:1};
 const event=sanitizeEvent({id:crypto.randomUUID(),run_id:'run-1',producer:'fixture',stage:'article.fetch',status:'completed',details:detail});
 assert.deepEqual(event.details,detail);
 const invalid=sanitizeEvent({...event,details:{source_hash:'token',artifact_hash:'token',input_hash:'token',receipt_at:'September 14',provider:'https://secret'}});
 assert.deepEqual(invalid.details,{});
 const events=[];
 const trace=createPipelineTrace({producer:'supabase-edge',sb:async(_,init)=>{events.push(...JSON.parse(init.body).p_events);return reply(1);}});
 await trace.emit('article.fetch','started');
 await trace.emit('article.parse','completed');
 await trace.emit('publication.write','completed');
 await trace.emit('run','completed',{details:{executor:'explicit',method:'explicit'}});
 assert.deepEqual(events.map(e=>e.details.method),['safeFetch-http','html-parser','compare-and-swap','explicit']);
 assert.equal(events[0].details.executor,'supabase-edge');assert.equal(events[3].details.executor,'explicit');
});
test('trace keeps one run identity and captures observation when stage executes',async()=>{
 const events=[];const trace=createPipelineTrace({sb:async(_,init)=>{events.push(...JSON.parse(init.body).p_events);return new Response('null');},producer:'supabase-edge'});
 await trace.emit('extraction','started',{entity_type:'story',entity_key:'2026-09-14:story-1'});
 await trace.emit('extraction','completed',{entity_type:'story',entity_key:'2026-09-14:story-1'});
 assert.equal(events[0].run_id,events[1].run_id);assert.notEqual(events[0].id,events[1].id);
 assert.ok(Date.parse(events[1].observed_at)>=Date.parse(events[0].observed_at));
});

import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {stripTypeScriptTypes} from 'node:module';
async function loadHandler(name,fetcher) {
 let handler;globalThis.Deno={env:{get:key=>({SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_ROLE_KEY:'service-fixture',AUDIT_PIPELINE_SECRET:'owner-fixture'}[key])},serve:fn=>handler=fn};
 globalThis.fetch=fetcher;
 const base=new URL(`../supabase/functions/${name}/index.ts`,import.meta.url);
 let source=(await readFile(base,'utf8')).replace(/import "jsr:[^"]+";/g,'').replace(/import \{ parseHTML \} from "https:[^"]+";/,'const parseHTML=()=>{throw Error("not expected")};');
 source=source.replace(/from (['"])(\.\.[^'"]+)\1/g,(_,q,path)=>'from '+q+new URL(path,base).href+q);
 await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64')+'#'+Math.random());
 return handler;
}
const request=(path='',init={})=>new Request('https://edge.invalid/'+path,{...init,headers:{'x-audit-secret':'owner-fixture',...init.headers}});
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status});
test('private endpoint and unchanged standby behavior',async t=>{
 const oldFetch=globalThis.fetch,oldDeno=globalThis.Deno,oldWarn=console.warn;
 try {
 await t.test('rejects unauthorized before touching database',async()=>{
  const handler=await loadHandler('pipeline-trace',()=>{throw Error('must not fetch');});
  assert.equal((await handler(new Request('https://edge.invalid'))).status,401);
 });
 await t.test('bounded sanitized post and filtered private GET',async()=>{
  const calls=[];const handler=await loadHandler('pipeline-trace',async(url,init)=>{calls.push({url,init});return reply(init.method==='POST'?1:[]);});
  const event={id:crypto.randomUUID(),run_id:'run-1',producer:'test',stage:'run',status:'started',entity_type:'day',entity_key:'2026-09-14',details:{body:'secret',count:1}};
  assert.equal((await handler(request('',{method:'POST',body:JSON.stringify({events:[event]})}))).status,200);
  assert.deepEqual(JSON.parse(calls[0].init.body).p_events[0].details,{count:1});assert.ok(calls[0].init.signal);
  assert.equal((await handler(request('?run_id=run-1&limit=9999'))).status,200);
  assert.equal(new URL(calls[1].url).searchParams.get('limit'),'500');
  assert.equal((await handler(request('?entity_key=x'))).status,400);
  assert.equal((await handler(request('',{method:'POST',body:JSON.stringify({events:Array(101).fill(event)})}))).status,400);
 });
 await t.test('actual Python emitted process and story events survive ingestion',async()=>{
  const output=execFileSync('python3',['-c',`
import sys,json,tempfile
sys.path.insert(0,'scripts')
from pipeline_trace import Run
with tempfile.TemporaryDirectory() as directory:
 run=Run('python-test',directory=directory)
 run.emit('process','degraded',details={'filled':2,'failed':1,'words':500,'exit_code':-1,'attempted':3,'skipped':0,'reason':'fetch_failed'})
 run.emit('article.fetch','running',entity_type='story',entity_key='2026-09-14/story-1')
 print(json.dumps([json.loads(line) for line in run.path.read_text().splitlines()]))
`],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
  const events=JSON.parse(output);let posted;
  const handler=await loadHandler('pipeline-trace',async(_,init)=>{posted=JSON.parse(init.body).p_events;return reply(2);});
  assert.equal((await handler(request('',{method:'POST',body:JSON.stringify({events})}))).status,200);
  assert.equal(posted[0].entity_type,'run');assert.equal(posted[0].entity_key,events[0].run_id);
  assert.deepEqual(posted[0].details,events[0].details);assert.equal(posted[1].entity_key,'2026-09-14/story-1');
 });
 await t.test('keyset report pagination preserves tied timestamp microseconds and story keys',async()=>{
  const id=crypto.randomUUID(),stamp='2026-09-14T12:00:00.123456+00:00';const urls=[];
  const handler=await loadHandler('pipeline-trace',async url=>{urls.push(new URL(url));return reply(urls.length===1?[{id,recorded_at:stamp}]:[]);});
  const first=await (await handler(request('?entity_type=story&entity_key=2026-09-14/story-1&limit=1'))).json();
  assert.ok(first.next_cursor);assert.equal(urls[0].searchParams.get('entity_key'),'eq.2026-09-14/story-1');
  const second=await (await handler(request('?entity_type=story&entity_key=2026-09-14/story-1&limit=1&cursor='+first.next_cursor))).json();
  assert.equal(second.next_cursor,null);
  assert.equal(urls[1].searchParams.get('or'),`(recorded_at.gt.${stamp},and(recorded_at.eq.${stamp},id.gt.${id}))`);
  assert.equal((await handler(request('?run_id=run-1&cursor=invalid'))).status,400);
 });
 await t.test('database error messages are never exposed',async()=>{
  const handler=await loadHandler('pipeline-trace',async()=>reply({secret:'token'},500));
  const response=await handler(request('?run_id=run-1'));assert.equal(response.status,503);assert.ok(!(await response.text()).includes('token'));
 });
 await t.test('trace failure preserves no-day response and original database exception',async()=>{
  console.warn=()=>{};let failDay=false;const original=new Error('original database failure');
  const handler=await loadHandler('fill-content',async(url)=>{if(url.includes('pipeline_record_events'))throw Error('trace failure');if(failDay)throw original;return reply([]);});
  const response=await handler(request('?date=2026-09-14&force=1'));assert.deepEqual(await response.json(),{ok:true,note:'no day for 2026-09-14'});
  failDay=true;await assert.rejects(()=>handler(request('?date=2026-09-14&force=1')),error=>error===original);
 });
 await t.test('standby skip and empty-queue outcomes are recorded without writes',async()=>{
  for(const mode of ['primary_fresh','no_targets']) {
   const events=[];
   const handler=await loadHandler('fill-content',async(url,init)=>{
    if(url.includes('pipeline_record_events')){events.push(...JSON.parse(init.body).p_events);return reply(1);}
    if(url.includes('publication_workers?'))return reply([{data:{state:'completed',lastRun:new Date().toISOString()}}]);
    if(url.includes('/days?'))return reply([{data:{stories:[]}}]);
    if(url.includes('audit_claim_fill'))return reply([]);
    throw Error('Unexpected pipeline write');
   });
   const response=await handler(request('?date=2026-09-14'+(mode==='no_targets'?'&force=1':'')));
   assert.equal(response.status,200);assert.equal(events.at(-1).status,'skipped');assert.equal(events.at(-1).details.phase,mode);assert.equal(events[0].details.span_id,events.at(-1).details.span_id);assert.ok(events[0].details.span_id);
  }
 });
 await t.test('standby requests keep independent correlation headers',async()=>{
  const runs=[];const handler=await loadHandler('fill-content',async(url,init)=>{if(url.includes('pipeline_record_events'))return reply(1);runs.push(init.headers['x-briefing-run-id']);return reply([]);});
  await Promise.all([handler(request('?date=2026-09-14&force=1')),handler(request('?date=2026-09-14&force=1'))]);
  assert.equal(new Set(runs).size,2);
 });
 } finally {globalThis.fetch=oldFetch;globalThis.Deno=oldDeno;console.warn=oldWarn;}
});
