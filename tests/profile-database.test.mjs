import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const runtime=process.env.PGLITE_MODULE || '@electric-sql/pglite';
const {PGlite}=await import(runtime);
const token='a'.repeat(64);
const id=n=>`12345678-1234-4234-8234-${String(n).padStart(12,'0')}`;
const mutation=(n,add,remove=[])=>({id:id(n),sets:{read:{add,remove}}});
async function setup(migrate=true){const db=new PGlite();await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema extensions; create schema reader_private;
create table public.prefs(profile text primary key,data jsonb,updated_at timestamptz);
create table public.push_subs(id text primary key,profile text,sub jsonb);
create table reader_private.credentials(profile text primary key,pin_hash text,legacy_hash text);
create table reader_private.sessions(token_hash text primary key,profile text,expires_at timestamptz);
create table reader_private.attempts(key_hash text primary key,window_start timestamptz,attempts integer);
-- Only hashing is replaced in this isolated fixture; production authentication SQL is unchanged.
create function extensions.digest(text,text) returns bytea language sql immutable as 'select decode(md5($1),''hex'')';
insert into public.prefs values ('one','{"read":["old"],"name":"One"}',now()),('two','{}',now());
insert into reader_private.credentials(profile) values('one'),('two');
insert into reader_private.sessions values(encode(extensions.digest('${token}','sha256'),'hex'),'one',now()+interval '1 day');
`);const original=await readFile(new URL('../supabase/migrations/202609060001_reader_profiles.sql',import.meta.url),'utf8');await db.exec(original.slice(original.indexOf('create or replace function'),original.lastIndexOf('commit;')));if(migrate && !process.env.PROFILE_TEST_BASELINE)await db.exec(await readFile(new URL('../supabase/migrations/202609110003_profile_set_deltas.sql',import.meta.url),'utf8'));return db;}
async function patch(db,mutations,extra={}){const payload={action:'patch',profile:'one',token,changes:{},mutations,...extra};return (await db.query('select public.reader_profile_api($1::jsonb) as result',[JSON.stringify(payload)])).rows[0].result;}
test('SQL deltas preserve independent additions, offline removes, retry receipts and private metadata',async()=>{const db=await setup();try {assert.deepEqual((await patch(db,[mutation(1,['a'])])).data.read,['old','a']);assert.deepEqual((await patch(db,[mutation(2,['b'],['old'])])).data.read,['a','b']);await patch(db,[mutation(3,[],['a'])]);const replay=await patch(db,[mutation(1,['a'])]);assert.deepEqual(replay.data.read,['b']);assert.equal(replay.data.name,'One');assert.equal((await patch(db,[mutation(1,['different'])])).status,409);assert.equal((await patch(db,[],{token:'bad'})).status,401);assert.equal((await patch(db,[],{profile:'two'})).status,401);}finally{await db.close();}});
test('SQL validates all deltas before writing and retains legacy patches',async()=>{const db=await setup();try{for(const bad of [{...mutation(1,[]),sets:{pin:{add:[],remove:[]}}},{...mutation(1,[]),sets:{read:{add:[2],remove:[]}}},{...mutation(1,[]),sets:{saved:{add:[{key:'x'}],remove:[]}}}, {...mutation(1,[]),sets:{read:{add:[],remove:[2]}}}])assert.equal((await patch(db,[mutation(20,['must-not-save']),bad])).status,400);assert.deepEqual((await patch(db,[])).data.read,['old']);assert.equal((await db.query('select count(*)::int as n from reader_private.mutation_receipts')).rows[0].n,0);assert.deepEqual((await patch(db,[],{changes:{read:['legacy']}})).data.read,['legacy']);assert.equal((await patch(db,[mutation(2,['x'])],{changes:{read:[]}})).status,400);const grants=await db.query("select has_function_privilege('anon','public.reader_profile_api(jsonb,text)','EXECUTE') as allowed");assert.equal(grants.rows[0].allowed,false);}finally{await db.close();}});
test('SQL saved keys replace metadata without replacing other bookmarks',async()=>{const db=await setup();try{const saved=(n,add,remove=[])=>({id:id(n),sets:{saved:{add,remove}}});const story=(key,title=key)=>({key,date:'2026-09-11',id:key,title});await patch(db,[saved(1,[story('a'),story('b')])]);const result=await patch(db,[saved(2,[story('a','Updated')],['b'])]);assert.deepEqual(result.data.saved,[story('a','Updated')]);const invalid=await patch(db,[saved(3,[{...story('x'),market:5}])]);assert.equal(invalid.status,400);}finally{await db.close();}});
