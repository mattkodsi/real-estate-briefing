import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const {PGlite}=await import(process.env.BACKEND_PGLITE_MODULE || '../../backend-test-runtime/node_modules/@electric-sql/pglite/dist/index.js');
async function database(){
 const db=new PGlite();await db.exec(`
 create role anon;create role authenticated;create role service_role;
 create table days(date date primary key,data jsonb,generated_at timestamptz);
 create table push_log(id text primary key,created_at timestamptz default now());
 grant all on push_log to anon,authenticated;
 create table push_subs(id text primary key,profile text not null,sub jsonb not null);
 insert into push_subs values ('one','owner','{"endpoint":"https://push.test/one"}'),('two','owner','{"endpoint":"https://push.test/two"}');
 `);await db.exec(await readFile(new URL('../supabase/migrations/202609060002_backend_audit.sql',import.meta.url),'utf8'));return db;
}
test('enqueue and device claims dedupe, retry failed devices only, reject stale lease',async()=>{
 const db=await database();try{
 await db.exec(`select audit_enqueue_push('story',array['owner'],'{"title":"hello"}');select audit_enqueue_push('story',array['owner'],'{"title":"changed"}');`);
 assert.equal((await db.query('select * from audit_push_jobs')).rows.length,2);
 const [a]=(await db.query('select * from audit_claim_push()')).rows;const [b]=(await db.query('select * from audit_claim_push()')).rows;assert.notEqual(a.id,b.id);
 assert.equal((await db.query('select * from audit_claim_push()')).rows.length,0);
 await db.query(`select audit_finish_push($1,$2,'sent','')`,[a.id,a.claim_token]);
 await db.query(`select audit_finish_push($1,$2,'retry','503')`,[b.id,b.claim_token]);
 await db.exec(`update audit_push_jobs set next_attempt_at=now()-interval '1 second' where state='retry'`);
 const [retry]=(await db.query('select * from audit_claim_push()')).rows;assert.equal(retry.id,b.id);
 await assert.rejects(db.query(`select audit_finish_push($1,$2,'sent','')`,[b.id,b.claim_token]),/stale/);
 await db.query(`select audit_finish_push($1,$2,'sent','')`,[retry.id,retry.claim_token]);
 assert.equal((await db.query('select * from audit_claim_push()')).rows.length,0);
 }finally{await db.close();}
});
test('fill backoff advances beyond four persistent failures and publication uses CAS',async()=>{
 const db=await database();try{
 const candidates=JSON.stringify(Array.from({length:8},(_,i)=>({id:`s${i}`,url:`https://news.test/${i}`})));
 const first=await db.query(`select * from audit_claim_fill('2026-09-06',$1::jsonb,4)`,[candidates]);
 const second=await db.query(`select * from audit_claim_fill('2026-09-06',$1::jsonb,4)`,[candidates]);
 assert.equal(first.rows.length,4);assert.equal(second.rows.length,4);assert.equal(new Set([...first.rows,...second.rows].map(r=>r.story_id)).size,8);
 assert.equal((await db.query(`select * from audit_claim_fill('2026-09-06',$1::jsonb,4)`,[candidates])).rows.length,0);
 await db.exec(`insert into days values('2026-09-06','{"stories":[],"new":true}',now());`);
 assert.equal((await db.query(`select audit_publish_fill('2026-09-06','{"stories":[]}','{"generatedAt":"2026-09-06T12:00:00Z"}') as published`)).rows[0].published,false);
 assert.equal((await db.query(`select data from days`)).rows[0].data.new,true);
 assert.equal((await db.query(`select audit_publish_fill('2026-09-06','{"stories":[],"new":true}','{"generatedAt":"2026-09-06T12:00:00Z"}') as published`)).rows[0].published,true);
 }finally{await db.close();}
});
test('job RPCs and tables are unavailable to anonymous and authenticated clients',async()=>{
 const db=await database();try{
 for(const role of ['anon','authenticated']){
 assert.equal((await db.query(`select has_table_privilege($1,'public.push_log','TRUNCATE') as allowed`,[role])).rows[0].allowed,false);
 assert.equal((await db.query(`select has_function_privilege($1,'public.audit_claim_push()','EXECUTE') as allowed`,[role])).rows[0].allowed,false);
 assert.equal((await db.query(`select has_table_privilege($1,'public.audit_push_jobs','SELECT') as allowed`,[role])).rows[0].allowed,false);
 }
 }finally{await db.close();}
});
test('permanent gone result prunes only the failed endpoint and does not requeue it',async()=>{
 const db=await database();try{
 await db.exec(`select audit_enqueue_push('gone',array['owner'],'{}');`);
 const [a]=(await db.query('select * from audit_claim_push()')).rows;
 await db.query(`select audit_finish_push($1,$2,'gone','410')`,[a.id,a.claim_token]);
 assert.equal((await db.query('select * from push_subs')).rows.length,1);
 await db.exec(`select audit_enqueue_push('new',array['owner'],'{}');`);
 assert.equal((await db.query("select * from audit_push_jobs where event_id='new'")).rows.length,1);
 }finally{await db.close();}
});
