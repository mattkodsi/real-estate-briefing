import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../../backend-test-runtime/node_modules/@electric-sql/pglite/dist/index.js';
import {pgcrypto} from '../../backend-test-runtime/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
test('real PostgreSQL migration and authorization regression suite',async()=>{
 const db=new PGlite({extensions:{pgcrypto}});
 try {
 const migration=await readFile(new URL('../supabase/migrations/202609060001_reader_profiles.sql',import.meta.url),'utf8');
 const fixture=await readFile(new URL('./profile-server-db.test.sql',import.meta.url),'utf8');
 const sql=fixture.replace(/\\ir .*profile-migration-body.sql/,()=>migration.replace(/^begin;/,'').replace(/commit;\s*$/,''));
 await db.exec(sql);
 } finally {await db.close();}
});
test('committed failed logins persist limits; sessions, PIN changes and endpoint ownership are enforced',async()=>{
 const db=new PGlite({extensions:{pgcrypto}});
 try {
  const migration=await readFile(new URL('../supabase/migrations/202609060001_reader_profiles.sql',import.meta.url),'utf8');
  const fixture=await readFile(new URL('./profile-server-db.test.sql',import.meta.url),'utf8');
  await db.exec(fixture.split('DO $$')[0].replace(/\\ir .*profile-migration-body.sql/,()=>migration.replace(/^begin;/,'').replace(/commit;\s*$/,''))+'commit;');
  const rpc=async(payload,ip='test')=>(await db.query('select public.reader_profile_api($1::jsonb,$2) as result',[JSON.stringify(payload),ip])).rows[0].result;
  const bob=await rpc({action:'create',profile:'bob',name:'Bob',color:'#ffffff',pin:null});
  const bob2=await rpc({action:'login',profile:'bob'});
  assert.ok(bob.token); assert.equal(bob.data.hasPin,false);
  assert.equal((await rpc({action:'create',profile:'bob',name:'Override',color:'#ffffff'})).error,'profile_exists');
  const sub={endpoint:'https://push.example/device',keys:{auth:'auth',p256dh:'key'}};
  assert.deepEqual(await rpc({action:'subscription',profile:'bob',token:bob.token,sub}),{ok:true});
  const amy=await rpc({action:'login',profile:'amy',pin:'1234'});
  assert.equal((await rpc({action:'subscription',profile:'amy',token:amy.token,sub})).error,'endpoint_owned');
  assert.equal((await db.query('select profile from public.push_subs')).rows[0].profile,'bob');
  assert.equal((await rpc({action:'meta',profile:'bob',token:bob.token,name:'Bob',color:'#ffffff',pin:'5678'})).data.hasPin,true);
  assert.equal((await rpc({action:'load',profile:'bob',token:bob2.token})).error,'unauthorized');
  assert.ok((await rpc({action:'load',profile:'bob',token:bob.token})).data);
  assert.equal((await rpc({action:'login',profile:'bob'})).error,'unauthorized');
  await db.exec("update reader_private.sessions set expires_at=now()-interval '1 second' where profile='bob'");
  assert.equal((await rpc({action:'load',profile:'bob',token:bob.token})).error,'unauthorized');
  for(let i=0;i<11;i++) await rpc({action:'login',profile:'amy',pin:'0000'},'unique-'+i);
  assert.equal((await rpc({action:'login',profile:'amy',pin:'1234'},'new-address')).error,'rate_limited');
  assert.ok((await db.query("select max(attempts) as n from reader_private.attempts")).rows[0].n>10);
 } finally {await db.close();}
});
