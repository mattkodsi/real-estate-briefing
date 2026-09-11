import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const modulePath=process.env.PGLITE_MODULE || '@electric-sql/pglite';
test('delivery observations stamp acknowledged outcomes without backdating history or accepting stale claims',async()=>{
 const {PGlite}=await import(modulePath);const db=new PGlite();
 try {
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table push_subs(id text primary key,sub jsonb);
 create table audit_push_jobs(id bigint primary key,state text,attempts int,claim_token uuid,lease_until timestamptz,last_error text,next_attempt_at timestamptz,created_at timestamptz default now(),sub jsonb);
 insert into audit_push_jobs(id,state,attempts) values(99,'sent',1);`);
 const migration=new URL('../supabase/migrations/202609110005_delivery_observations.sql',import.meta.url);
 await assert.doesNotReject(()=>readFile(migration,'utf8'),'delivery observation migration must exist');
 await db.exec(await readFile(migration,'utf8'));
 assert.deepEqual((await db.query('select provider_accepted_at,last_finished_at from audit_push_jobs where id=99')).rows[0],{provider_accepted_at:null,last_finished_at:null});
 const token='11111111-1111-4111-8111-111111111111';
 for (const [id,attempts,outcome,expected] of [[1,1,'sent','sent'],[2,2,'retry','retry'],[3,10,'retry','failed'],[4,1,'gone','gone']]) {
   await db.query("insert into audit_push_jobs(id,state,attempts,claim_token,sub) values($1,'sending',$2,$3,'{\"endpoint\":\"https://device\"}')",[id,attempts,token]);
   await db.exec("insert into push_subs values('device','{\"endpoint\":\"https://device\"}') on conflict do nothing");
   await db.query('select audit_finish_push($1,$2,$3,null)',[id,token,outcome]);
   const row=(await db.query('select state,provider_accepted_at,last_finished_at,claim_token,lease_until,next_attempt_at from audit_push_jobs where id=$1',[id])).rows[0];
   assert.equal(row.state,expected);assert.ok(row.last_finished_at);assert.equal(Boolean(row.provider_accepted_at),outcome==='sent');
   assert.equal(row.claim_token,null);assert.equal(row.lease_until,null);assert.ok(row.next_attempt_at);
   assert.equal((await db.query('select count(*)::int n from push_subs')).rows[0].n,outcome==='gone'?0:1);
   await assert.rejects(()=>db.query('select audit_finish_push($1,$2,$3,null)',[id,token,'sent']),/stale delivery lease/);
   assert.equal((await db.query('select last_finished_at from audit_push_jobs where id=$1',[id])).rows[0].last_finished_at.getTime(),row.last_finished_at.getTime());
 }
 await db.query("insert into audit_push_jobs(id,state,attempts,claim_token) values(5,'sending',1,$1)",[token]);
 for(const outcome of [null,'invalid']) await assert.rejects(()=>db.query('select audit_finish_push(5,$1,$2,null)',[token,outcome]),/invalid outcome/);
 await assert.rejects(()=>db.query("select audit_finish_push(5,null,'sent',null)"),/stale delivery lease/);
 await db.exec('begin');await db.query("select audit_finish_push(5,$1,'sent',null)",[token]);await db.exec('rollback');
 assert.equal((await db.query('select provider_accepted_at from audit_push_jobs where id=5')).rows[0].provider_accepted_at,null);
 for(const role of ['anon','authenticated']) {
   await db.exec('set role '+role);
   await assert.rejects(()=>db.query("select audit_finish_push(5,$1,'sent',null)",[token]),/permission denied/);
   await db.exec('reset role');
 }
 await db.exec('set role service_role');await db.query("select audit_finish_push(5,$1,'sent',null)",[token]);await db.exec('reset role');
 assert.ok((await db.query('select provider_accepted_at from audit_push_jobs where id=5')).rows[0].provider_accepted_at);
 }finally{await db.close();}
});
