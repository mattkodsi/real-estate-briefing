import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('publication trace is private, transactional, metadata-only and independent of writers',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite'); const db=new PGlite();
 try {
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table days(date text primary key,data jsonb,generated_at timestamptz);
 create table weeks(week_of text primary key,data jsonb);
 create table players(slug text primary key,data jsonb);create table terms(slug text primary key,data jsonb);
 create table threads(slug text primary key,data jsonb);create table campaigns(id text primary key,data jsonb);
 create table events(id text primary key,data jsonb);create table metrics(id text primary key,data jsonb);
 create table publication_workers(id text primary key,data jsonb);
 create table audit_push_jobs(id int primary key,state text,attempts int,sub jsonb,payload jsonb,claim_token text,provider_accepted_at timestamptz,device_received_at timestamptz);
 create table audit_fill_attempts(day text,story_id text,source_url text,attempts int,primary key(day,story_id,source_url));
 grant insert,update,select on days to anon;`);
 await db.exec(await readFile(new URL('../supabase/migrations/202609140001_publication_trace.sql',import.meta.url),'utf8'));
 const first={stories:[{id:'a',title:'SECRET TITLE',content:'SECRET BODY',url:'SECRET URL'},{id:'b',brief:true}]};
 await db.exec('set role anon');await db.query('insert into days values($1,$2,null)',['2026-09-14',first]);await db.exec('reset role');
 let rows=(await db.query('select * from pipeline_events')).rows;
 assert.equal(rows.length,3);assert.ok(rows.every(x=>x.source==='database'&&x.status==='committed'&&x.producer==='unknown'));
 assert.doesNotMatch(JSON.stringify(rows),/SECRET/);
 await db.query('update days set data=$1,generated_at=now()',[first]);assert.equal((await db.query('select count(*)::int n from pipeline_events')).rows[0].n,3);
 await db.exec(`set request.headers='{"x-briefing-run-id":"run-test","x-briefing-producer":"direct"}'`);
 await db.query('update days set data=$1',[{stories:[{id:'b',brief:false},first.stories[0]]}]);
 rows=(await db.query("select * from pipeline_events where run_id='run-test' and entity_type='story' order by entity_key")).rows;
 assert.equal(rows.length,2);assert.equal(rows[0].details.old_rank,1);assert.equal(rows[0].details.new_rank,2);assert.equal(rows[1].details.old_brief,true);assert.equal(rows[1].details.new_brief,false);
 const count=()=>db.query('select count(*)::int n from pipeline_events').then(x=>x.rows[0].n);const before=await count();
 await db.exec("begin;delete from days;rollback");assert.equal(await count(),before);
 await db.exec("insert into audit_push_jobs values(1,'retry',2,'{\"endpoint\":\"SECRET SUB\"}','{\"body\":\"SECRET PAYLOAD\"}','SECRET TOKEN',null,null)");
 assert.doesNotMatch(JSON.stringify((await db.query('select * from pipeline_events')).rows),/SECRET/);
 await db.exec("update audit_push_jobs set state='sent',attempts=3,provider_accepted_at=now(),device_received_at=now() where id=1");
 const push=(await db.query("select details from pipeline_events where entity_type='audit_push_jobs' order by recorded_at desc limit 1")).rows[0].details;
 assert.equal(push.new.state,'sent');assert.equal(push.new.attempts,3);assert.ok(push.new.provider_accepted_at);assert.ok(push.new.device_received_at);
 await db.exec("insert into publication_workers values('fill_test','{\"lastRun\":\"2026-09-14T11:00:00Z\",\"filled\":0,\"failed\":1,\"state\":\"completed\",\"error\":\"SECRET TOKEN\"}')");
 await db.exec("update publication_workers set data=jsonb_set(data,'{lastRun}','\"2026-09-14T11:01:00Z\"')");
 assert.equal((await db.query("select count(*)::int n from pipeline_events where entity_type='publication_workers'")).rows[0].n,2);
 await db.exec("insert into audit_fill_attempts values('2026-09-14','a','SECRET URL',1);update audit_fill_attempts set attempts=2");
 assert.equal((await db.query("select count(*)::int n from pipeline_events where entity_type='audit_fill_attempts'")).rows[0].n,2);
 for(const table of ['weeks','players','terms','threads','campaigns','events','metrics']){
   await db.query('insert into '+table+' values($1,$2)',['test',{content:'SECRET CONTENT'}]);
   await db.query('update '+table+' set data=$1',[{content:'SECRET CHANGED'}]);
   await db.exec('delete from '+table);
   assert.equal((await db.query('select count(*)::int n from pipeline_events where entity_type=$1',[table])).rows[0].n,3);
 }
 await db.exec('delete from days');
 assert.equal((await db.query("select count(*)::int n from pipeline_events where entity_type='story' and details->>'operation'='removed'")).rows[0].n,2);
 assert.doesNotMatch(JSON.stringify((await db.query('select * from pipeline_events')).rows),/SECRET/);
 const constraintBefore=await count();
 await assert.rejects(()=>db.exec("insert into days values(null,'{}',null)"),/null value/);assert.equal(await count(),constraintBefore);
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(()=>db.query('select * from pipeline_events'),/permission denied/);await assert.rejects(()=>db.query("select pipeline_record_events('[]')"),/permission denied/);await db.exec('reset role');}
 await db.exec('set role service_role');
 const event={id:'11111111-1111-4111-8111-111111111111',run_id:'run-test',producer:'test',stage:'read',status:'completed',entity_type:'email',entity_key:'hash-id',details:{story_count:2,error_type:'TimeoutError',body:'SECRET',token:'SECRET',source_hash:'abcdef',receipt_at:'2026-09-14T10:00:00Z'}};
 assert.equal((await db.query('select pipeline_record_events($1) n',[[event]])).rows[0].n,1);
 assert.equal((await db.query('select pipeline_record_events($1) n',[[event]])).rows[0].n,0);
 rows=(await db.query("select * from pipeline_events where source='producer'")).rows;assert.equal(rows[0].details.story_count,2);assert.equal(rows[0].details.body,undefined);assert.equal(rows[0].details.token,undefined);
 await assert.rejects(()=>db.query('update pipeline_events set status=\'bad\''),/permission denied|append.only/);await assert.rejects(()=>db.query('delete from pipeline_events'),/permission denied|append.only/);
 await assert.rejects(()=>db.query('select pipeline_record_events($1)',[Array(101).fill(event)]),/100/);
 await db.exec('reset role');
 // Malformed producer metadata and worker error text cannot leak or suppress real changes.
 await db.exec(`set request.headers='{"x-briefing-run-id":"https://secret/token","x-briefing-producer":"SECRET raw exception"}'`);
 await db.query("insert into days values('privacy',$1,null)",[{stories:[{id:'https://secret/token','SECRET field message':'x',good_field:1}],'https://secret/token':true}]);
 const privacy=(await db.query("select * from pipeline_events where entity_type='days' and entity_key='privacy'")).rows[0];
 assert.equal(privacy.producer,'unknown');assert.equal(privacy.run_id,null);assert.deepEqual(privacy.details.changed_fields,['stories']);
 await db.query("update publication_workers set data=$1",[{filled:'SECRET error',failed:'https://secret/token',errors:'SECRET exception',runId:'https://secret/token',state:'SECRET text',lastRun:'2026-99-99T11:00:00Z',processed:3}]);
 const worker=(await db.query("select details from pipeline_events where entity_type='publication_workers' order by recorded_at desc limit 1")).rows[0].details.new;
 assert.deepEqual(worker,{processed:3});
 await db.exec('set role service_role');
 await db.query('select pipeline_record_events($1)',[[{...event,id:'22222222-2222-4222-8222-222222222222',producer:'https://secret/token',details:{...event.details,source_hash:'SECRET raw data',receipt_at:'yesterday',reason:'SECRET raw exception',error_type:'https://secret/token',filled:'SECRET',failed:4,method:'postgres-trigger',executor:'supabase-postgres',artifact_hash:'b'.repeat(64)}}]]);
 const clean=(await db.query("select * from pipeline_events where id='22222222-2222-4222-8222-222222222222'")).rows[0];
 assert.equal(clean.producer,'unknown');assert.equal(clean.details.failed,4);assert.equal(clean.details.method,'postgres-trigger');assert.equal(clean.details.artifact_hash,'b'.repeat(64));
 for(const key of ['source_hash','receipt_at','reason','error_type','filled'])assert.equal(clean.details[key],undefined);
 await db.exec('reset role');
 assert.doesNotMatch(JSON.stringify((await db.query('select * from pipeline_events')).rows),/SECRET|https:\/\/secret/);
 // A logger failure must not block the original write; its own subtransaction rolls back.
 await db.exec('alter table pipeline_events add constraint force_trace_failure check(false) not valid');
 await db.exec("insert into players values('safe','{}')");assert.equal((await db.query("select count(*)::int n from players where slug='safe'")).rows[0].n,1);
 }finally{await db.close();}
});
