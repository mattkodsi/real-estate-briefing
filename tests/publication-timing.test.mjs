import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';

test('standby filler publishes observed readiness timestamps through its real CAS SQL',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
 const db=new PGlite();const oldFetch=globalThis.fetch,oldDeno=globalThis.Deno;
 try {
  const initial={date:'2026-09-11',generatedAt:'2026-09-11T00:00:00Z',stories:[{id:'a',title:'Original',summary:'Original summary',url:'https://example.invalid/article',content:null}]};
  await db.exec('create table days(date date primary key,data jsonb,generated_at timestamptz);');
  await db.query('insert into days values ($1,$2,$3)',[initial.date,JSON.stringify(initial),initial.generatedAt]);
  const migration=await readFile(new URL('../supabase/migrations/202609060002_backend_audit.sql',import.meta.url),'utf8');
  const sql=migration.match(/create or replace function public\.audit_publish_fill\([\s\S]*?end \$\$;/)?.[0];
  assert.ok(sql,'exercise the checked-in CAS body, not a test copy');await db.exec(sql);
  let handler;
  globalThis.Deno={env:{get:k=>({SUPABASE_URL:'https://database.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-service',AUDIT_PIPELINE_SECRET:'fixture-owner'}[k])},serve:fn=>handler=fn};
  const reply=x=>new Response(JSON.stringify(x));
  globalThis.fetch=async(url,init)=>{
   if(url.includes('/days?'))return reply([{data:initial}]);
   if(url.includes('/secrets?'))return reply([]);
   if(url.endsWith('/rpc/audit_claim_fill'))return reply([{story_id:'a',source_url:initial.stories[0].url}]);
   if(url.endsWith('/rpc/audit_publish_fill')){
    const b=JSON.parse(init.body);
    const result=await db.query('select audit_publish_fill($1,$2,$3) as ok',[b.p_day,JSON.stringify(b.p_expected),JSON.stringify(b.p_data)]);
    return reply(result.rows[0].ok);
   }
   if(url.endsWith('/secrets')||url.endsWith('/publication_workers'))return reply({});
   throw Error('Unexpected external request '+url);
  };
  const base=new URL('../supabase/functions/fill-content/index.ts',import.meta.url);
  let source=(await readFile(base,'utf8')).replace(/import "jsr:[^"]+";/g,'');
  // Extraction/network are fixtures; execute the real handler's selection,
  // readiness transition, mutation and database publication paths.
  source=source.replace(/import \{ safeFetch \} from "[^"]+";/,'const safeFetch=async()=>({ok:true,html:"fixture",finalUrl:"https://example.invalid/article"});');
  source=source.replace(/import \{ parseHTML \} from "[^"]+";/,'const parseHTML=()=>{throw Error("Unused extraction fixture")};');
  source=source.replace('out = extract(html);','out = {ok:true,words:120,html:"<p>" + "The buyer completed the purchase after reviewing the financing documents and will retain all existing tenants. ".repeat(8) + "</p>",image:null};');
  source=source.replace(/from (['"])(\.\.[^'"]+)\1/g,(_,q,path)=>'from '+q+new URL(path,base).href+q);
  await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
  const response=await handler(new Request('https://example.invalid?date=2026-09-11&force=1',{headers:{'x-audit-secret':'fixture-owner'}}));
  assert.equal(response.status,200);assert.deepEqual((await response.json()).filled,['a']);
  const stored=(await db.query('select data from days')).rows[0].data;
  assert.equal(stored.stories[0].enrichedBy,'supabase-edge');
  assert.ok(Number.isFinite(Date.parse(stored.stories[0].contentReadyAt)));
  assert.equal(stored.stories[0].contentReadyAt,stored.stories[0].enrichedAt);
  assert.equal(stored.publishedAt,stored.generatedAt);
  assert.equal(stored.stories[0].summaryPublishedAt,undefined,'legacy summary is not backdated by enrichment');
  const conflict=await db.query('select audit_publish_fill($1,$2,$3) as ok',[initial.date,JSON.stringify(initial),JSON.stringify({...initial,stories:[]})]);
  assert.equal(conflict.rows[0].ok,false,'stale replacement cannot remove timing evidence');
 } finally {globalThis.fetch=oldFetch;globalThis.Deno=oldDeno;await db.close();}
});
