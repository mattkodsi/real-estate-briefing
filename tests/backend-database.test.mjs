import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
// Optional local-only runtime; no database URL or production connection is accepted.
const modulePath=process.env.PGLITE_MODULE || '@electric-sql/pglite';
test('capture, push exhaustion and discovery operate atomically in isolated PostgreSQL',async()=>{
 const {PGlite}=await import(modulePath);const db=new PGlite();
 try {
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table secrets(id text primary key,data jsonb);create table app_status(id text primary key,data jsonb);
 create table push_subs(id text primary key,sub jsonb);
 create table days(date date primary key,data jsonb);
 create table audit_push_jobs(id bigint primary key,state text,attempts int,claim_token uuid,lease_until timestamptz,last_error text,next_attempt_at timestamptz,sub jsonb);
 insert into days values((now() at time zone 'America/New_York')::date-1,'{"stories":[{"id":"baseline"}]}');`);
 await db.exec(await readFile(new URL('../supabase/migrations/202609110002_backend_reliability.sql',import.meta.url),'utf8'));
 const hash='a'.repeat(64), cookie='session='+ 'x'.repeat(40);
 await db.query('select issue_capture_ticket($1,$2)',[hash,'bisnow.com']);
 assert.equal((await db.query('select capture_publisher_session($1,$2,$3) ok',[hash,'inman.com',cookie])).rows[0].ok,false);
 assert.equal((await db.query('select capture_publisher_session($1,$2,$3) ok',[hash,'bisnow.com',cookie])).rows[0].ok,true);
 assert.equal((await db.query('select capture_publisher_session($1,$2,$3) ok',[hash,'bisnow.com',cookie])).rows[0].ok,false);
 assert.equal((await db.query('select count(*)::int n from secrets')).rows[0].n,1);
 await db.query('select issue_capture_ticket($1,$2)',[hash,'bisnow.com']);
 await db.exec("update publisher_capture_tickets set expires_at=now()-interval '1 minute'");
 assert.equal((await db.query('select capture_publisher_session($1,$2,$3) ok',[hash,'bisnow.com',cookie])).rows[0].ok,false);
 await db.exec("set role anon");
 await assert.rejects(()=>db.query('select capture_publisher_session(null,$1,$2)',['bisnow.com',cookie]),/permission denied/);
 await db.exec('reset role');
 const token='11111111-1111-4111-8111-111111111111';
 await db.query("insert into audit_push_jobs(id,state,attempts,claim_token,sub) values(1,'sending',10,$1,'{\"endpoint\":\"https://device\"}')",[token]);
 await db.exec("insert into push_subs values('device','{\"endpoint\":\"https://device\"}')");
 await db.query("select audit_finish_push(1,$1,'retry','temporary failure')",[token]);
 assert.equal((await db.query('select state from audit_push_jobs')).rows[0].state,'failed');
 assert.equal((await db.query('select count(*)::int n from push_subs')).rows[0].n,1);
 await db.query("update audit_push_jobs set state='sending',claim_token=$1",[token]);
 await db.query("select audit_finish_push(1,$1,'gone','410')",[token]);
 assert.equal((await db.query('select count(*)::int n from push_subs')).rows[0].n,0);
 const today=(await db.query("select to_char((now() at time zone 'America/New_York')::date,'YYYY-MM-DD') as date_value")).rows[0].date_value;
 const yesterday=(await db.query("select to_char((now() at time zone 'America/New_York')::date-1,'YYYY-MM-DD') as date_value")).rows[0].date_value;
 const docs=[{date:yesterday,data:{stories:[{id:'baseline'},{id:'late'}]}},{date:today,data:{stories:[{id:'new'}]}},{date:'2000-01-01',data:{stories:[{id:'archive'}]}}];
 const found=(await db.query('select audit_discover_stories($1,$2) result',[JSON.stringify(docs),today])).rows[0].result;
 assert.deepEqual(found.sort(),[yesterday+':late',today+':new'].sort());
 }finally{await db.close();}
});
