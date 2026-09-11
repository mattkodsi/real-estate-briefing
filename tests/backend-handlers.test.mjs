import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {checkedFetch} from '../supabase/functions/_shared/backend-policy.mjs';
async function load(name,fetcher){
 let handler;globalThis.Deno={env:{get:key=>({SUPABASE_URL:'https://database.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-service',AUDIT_PIPELINE_SECRET:'fixture-owner'}[key])},serve:fn=>{handler=fn;}};
 globalThis.fetch=fetcher;
 const base=new URL(`../supabase/functions/${name}/index.ts`,import.meta.url);
 let source=(await readFile(base,'utf8')).replace(/import "jsr:[^"]+";/g,'');
 if(name==='push-dispatch') {
  source=source.replace(/import \* as webpush from "jsr:[^"]+";/, 'const webpush={importVapidKeys:async()=>({}),ApplicationServer:{new:async()=>({subscribe:()=>({pushTextMessage:async()=>{throw new Error("Unexpected push in test");}})})}};');
  source=source.replace('const { date: today, hour } = nowET();','const {date:today,hour}={date:"2026-09-11",hour:12};');
 }
 source=source.replace(/from (['"])(\.\.[^'"]+)\1/g,(_,q,path)=>'from '+q+new URL(path,base).href+q);
 await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64')+'#'+Math.random());
 return handler;
}
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status});
test('synthetic handlers: no real services or credentials',async t=>{
 const originalFetch=globalThis.fetch,originalDeno=globalThis.Deno;
 try{
 await t.test('store-session rejects anonymous capture before any privileged request',async()=>{
  let calls=0;const handler=await load('store-session',async()=>{calls++;throw Error('unexpected request');});
  const response=await handler(new Request('https://example.invalid',{method:'POST',body:JSON.stringify({domain:'bisnow.com',cookie:'session='+ 'x'.repeat(25)})}));
  assert.equal(response.status,401);assert.equal(calls,0);
 });
 await t.test('valid ticket writes through one atomic RPC; no browser credential returned',async()=>{
  let calls=[];const handler=await load('store-session',async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return reply(true);});
  const response=await handler(new Request('https://example.invalid',{method:'POST',body:JSON.stringify({domain:'bisnow.com',cookie:'session='+ 'x'.repeat(25),captureToken:'a'.repeat(64)})}));
  assert.equal(response.status,200);assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith('/rpc/capture_publisher_session'));
  assert.notEqual(calls[0].body.p_hash,'a'.repeat(64));assert.deepEqual(Object.keys(await response.json()).sort(),['cookieLen','domain','ok']);
 });
 await t.test('rates returns lastgood on upstream failure and bounds every request',async()=>{
  const old={curveDate:'2026-09-01',treasury:{'10Y':4.2},forward:[]};let calls=0;
  const handler=await load('rates-live',async(url,init)=>{calls++;assert.ok(init.signal);return url.includes('/rates_cache?')?reply([{data:old,generated_at:'2000-01-01'}]):reply({},503);});
  const response=await handler(new Request('https://example.invalid'));const data=await response.json();
  assert.equal(data.treasury['10Y'],4.2);assert.equal(data.stale,true);assert.ok(calls>1);
 });
 await t.test('market partial refresh retains individual series and failed cache writes are surfaced',async()=>{
  const old={national:{ust2y:{latest:{date:'2026-09-01',value:3}}},metros:{'New York':{rent:{latest:{date:'2026-08-01',value:4000}}}}};let written;
  const handler=await load('market-pulse',async(url,init)=>{
   if(url.includes('/market_pulse?'))return reply([{data:old,generated_at:'2000-01-01'}]);
   if(url.includes('/secrets?'))return reply([{data:{key:'fixture-key'}}]);
   if(url.includes('series_id=DGS10&'))return reply({observations:[{date:'2026-09-01',value:'4.2'}]});
   if(url.endsWith('/market_pulse')){written=JSON.parse(init.body).data;return reply({},503);}
   return reply({},503);
  });
  const data=await (await handler(new Request('https://example.invalid'))).json();
  assert.equal(written.national.ust2y.stale,true);assert.equal(written.national.ust10y.latest.value,4.2);
  assert.equal(written.metros['New York'].rent.latest.value,4000);assert.equal(data.stale,true);assert.equal(data.national.ust2y.latest.value,3);
 });
 await t.test('breaking/watch dedupe is per profile, preserving watch-only readers',async()=>{
  const queued=[];const story={id:'story-1',pushEligible:true,title:'New development',summary:'A complete summary.'};
  const handler=await load('push-dispatch',async(url,init)=>{
   if(url.includes('/rpc/')){
    const name=url.split('/rpc/')[1],body=JSON.parse(init.body);queued.push({name,body});
    return reply(name==='audit_discover_stories'?['2026-09-11:story-1']:name==='audit_claim_push'?[]:null);
   }
   if(url.includes('/push_subs?'))return reply(['breaking-reader','watch-reader'].map(profile=>({profile,sub:{endpoint:'https://device.invalid/'+profile}})));
   if(url.includes('/prefs?'))return reply([{profile:'breaking-reader',data:{watchPlayers:['player'],notifications:{breaking:true}}},{profile:'watch-reader',data:{watchPlayers:['player'],notifications:{breaking:false}}}]);
   if(url.includes('/secrets?'))return reply([{data:{publicJwk:{},privateJwk:{}}}]);
   if(url.includes('/days?'))return reply([{date:'2026-09-11',data:{stories:[story]}}]);
   if(url.includes('/players?'))return reply([{slug:'player',data:{name:'Player',mentions:[{date:'2026-09-11',id:'story-1',title:'New development'}]}}]);
   if(url.includes('/audit_watch_seen?')||url.includes('/audit_push_jobs?')||url.includes('/events?'))return reply([]);
   throw Error('Unexpected mocked URL '+url);
  });
  const response=await handler(new Request('https://example.invalid',{headers:{'x-audit-secret':'fixture-owner'}}));
  assert.equal(response.status,200);
  assert.deepEqual(queued.find(x=>x.name==='audit_enqueue_push').body.p_profiles,['breaking-reader']);
  assert.deepEqual(queued.filter(x=>x.name==='audit_enqueue_watch').map(x=>x.body.p_profile),['watch-reader']);
 });
 await t.test('checked fetch rejects failed HTTP writes',async()=>{
  await assert.rejects(()=>checkedFetch('https://example.invalid',{},async()=>reply({},500)),/500/);
 });
 }finally{globalThis.fetch=originalFetch;globalThis.Deno=originalDeno;}
});
