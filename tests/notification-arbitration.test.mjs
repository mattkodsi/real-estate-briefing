import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

async function fixture(upgrade=true) {
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table push_log(id text primary key);
 create table push_subs(id text primary key,profile text,sub jsonb);
 create table prefs(profile text primary key,data jsonb);
 create table days(date date primary key,data jsonb,generated_at timestamptz);
 create table secrets(id text primary key,data jsonb);
 create table app_status(id text primary key,data jsonb);
 insert into prefs values ('a','{"watchPlayers":["actor","other"]}'),('b','{"watchPlayers":["actor"],"notifications":{"breaking":false}}');
 insert into push_subs values ('a1','a','{"endpoint":"https://example.test/a1"}'),('a2','a','{"endpoint":"https://example.test/a2"}'),('b1','b','{"endpoint":"https://example.test/b1"}');`);
 for(const name of ['202609060002_backend_audit.sql','202609110002_backend_reliability.sql']) await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 if(upgrade) await db.exec(await readFile(new URL('../supabase/migrations/202609110004_story_alert_arbitration.sql',import.meta.url),'utf8'));
 return db;
}
const items=[{id:'story',title:'A story',name:'Actor',slug:'actor'},{id:'story',title:'A story',name:'Other actor',slug:'other'}];
const breaking=(db,profiles=['a','b'])=>db.query('select audit_enqueue_push($1,$2,$3)',['spec:2026-09-11:story',profiles,JSON.stringify({title:'News',body:'Story',tag:'spec:2026-09-11:story'})]);
const watch=(db,profile='a',batch=items)=>db.query('select audit_enqueue_watch($1,$2,$3)',[profile,'2026-09-11',JSON.stringify(batch)]);

for(const first of ['breaking','watch']) test(`one story reason per profile/device when ${first} queues first`,async()=>{
 const db=await fixture();try {
 if(first==='breaking'){await breaking(db);await watch(db);}else{await watch(db);await breaking(db);}
 await watch(db,'b');await breaking(db);await watch(db);
 const rows=(await db.query('select profile,device_id,count(*)::int n from audit_push_jobs group by profile,device_id')).rows;
 assert.equal(rows.length,3);assert.ok(rows.every(r=>r.n===1),JSON.stringify(rows));
 const a=(await db.query("select event_id from audit_push_jobs where profile='a' limit 1")).rows[0].event_id;
 assert.ok(a.startsWith(first==='breaking'?'spec:':'watch:'));
 }finally{await db.close();}
});

test('disabled devices and opted-out reasons do not consume story reservations; retries add no duplicate jobs',async()=>{
 const db=await fixture();try {
 await db.exec("update push_subs set sub=sub||'{\"disabled\":true}' where profile='a'");
 await breaking(db,['a']);await watch(db);
 assert.equal((await db.query('select count(*)::int n from audit_story_alerts')).rows[0].n,0);
 await db.exec("update push_subs set sub=sub||'{\"disabled\":false}' where profile='a'");
 await watch(db);await watch(db);await breaking(db,['a']);
 assert.equal((await db.query('select count(*)::int n from audit_push_jobs')).rows[0].n,2);
 await db.exec("insert into push_subs values('a3','a','{\"endpoint\":\"https://example.test/a3\"}')");
 // A different breaking event must not bypass the original watch choice.
 await breaking(db,['a']);assert.equal((await db.query('select count(*)::int n from audit_push_jobs')).rows[0].n,2);
 }finally{await db.close();}
});

test('reservation and watch-seen writes roll back if enqueue fails; public callers remain denied',async()=>{
 const db=await fixture();try {
 await db.exec("alter table audit_push_jobs add constraint fail_test check(profile<>'a')");
 await assert.rejects(()=>watch(db),/fail_test/);
 assert.equal((await db.query('select count(*)::int n from audit_story_alerts')).rows[0].n,0);
 assert.equal((await db.query('select count(*)::int n from audit_watch_seen')).rows[0].n,0);
 await db.exec('alter table audit_push_jobs drop constraint fail_test;set role anon');
 await assert.rejects(()=>watch(db),/permission denied/);
 await assert.rejects(()=>breaking(db),/permission denied/);
 await assert.rejects(()=>db.query('select * from audit_story_alerts'),/permission denied/);
 }finally{await db.close();}
});

test('upgrade preserves old reservations without queueing or replaying notifications',async()=>{
 const db=await fixture(false);try {
 await watch(db);await breaking(db,['b']);
 const before=(await db.query('select count(*)::int n from audit_push_jobs')).rows[0].n;
 await db.exec(await readFile(new URL('../supabase/migrations/202609110004_story_alert_arbitration.sql',import.meta.url),'utf8'));
 assert.equal((await db.query('select count(*)::int n from audit_push_jobs')).rows[0].n,before);
 await breaking(db);await watch(db,'b');
 assert.equal((await db.query('select count(*)::int n from audit_push_jobs')).rows[0].n,before);
 }finally{await db.close();}
});


test('watch bundle excludes breaking-reserved story but retains fresh stories and merged actors',async()=>{
 const db=await fixture();try {
 await breaking(db,['a']);
 await watch(db,'a',[...items,{id:'second',title:'Second story',name:'Actor',slug:'actor'},{id:'second',title:'Second story',name:'Other',slug:'other'}]);
 const payload=(await db.query("select payload from audit_push_jobs where event_id like 'watch:%' limit 1")).rows[0].payload;
 assert.equal(payload.watchItems.length,1);assert.equal(payload.watchItems[0].id,'second');
 assert.equal(payload.watchItems[0].slugs.length,2);
 assert.equal((await db.query("select count(*)::int n from audit_story_alerts where profile='a'")).rows[0].n,2);
 }finally{await db.close();}
});

test('chosen breaking event can fill a newly registered device without duplicating existing devices',async()=>{
 const db=await fixture();try {
 await breaking(db,['a']);await breaking(db,['a']);
 await db.exec("insert into push_subs values('a3','a','{\"endpoint\":\"https://example.test/a3\"}')");
 await breaking(db,['a']);await watch(db);
 assert.equal((await db.query('select count(*)::int n from audit_push_jobs')).rows[0].n,3);
 assert.equal((await db.query('select count(*)::int n from audit_story_alerts')).rows[0].n,1);
 }finally{await db.close();}
});


test('legacy global breaking log blocks cross-reason watch replay after upgrade',async()=>{
 const db=await fixture(false);try {
 await db.exec("insert into push_log values('spec:2026-09-11:story')");
 await db.exec(await readFile(new URL('../supabase/migrations/202609110004_story_alert_arbitration.sql',import.meta.url),'utf8'));
 await watch(db);await watch(db,'b');await breaking(db);
 assert.equal((await db.query('select count(*)::int n from audit_push_jobs')).rows[0].n,0);
 assert.equal((await db.query('select count(*)::int n from audit_story_alerts')).rows[0].n,0);
 }finally{await db.close();}
});


test('legacy watch log blocks breaking and changed-actor watch replay only for that profile',async()=>{
 const db=await fixture(false);try {
 await db.exec("insert into push_log values('watch:a:2026-09-11:former-actor:story')");
 await db.exec(await readFile(new URL('../supabase/migrations/202609110004_story_alert_arbitration.sql',import.meta.url),'utf8'));
 await breaking(db);await watch(db);await watch(db,'b');
 const rows=(await db.query('select profile,event_id from audit_push_jobs')).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].profile,'b');assert.ok(rows[0].event_id.startsWith('watch:'));
 }finally{await db.close();}
});
