import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {authorized} from '../supabase/functions/_shared/audit-auth.mjs';
import {drainDeliveries} from '../supabase/functions/_shared/audit-delivery.mjs';
async function load(name, fetcher, webpush = {}) {
 const src=await readFile(new URL(`../supabase/functions/${name}/index.ts`,import.meta.url),'utf8');
 const js=stripTypeScriptTypes(src.replace(/^import .*;\n/gm,'').replace(/export /g,''));
 let handler;const Deno={env:{get:k=>k==='AUDIT_PIPELINE_SECRET'?'server-secret':'fake'},serve:h=>{handler=h;}};
 const deny=req=>authorized(req,'server-secret')?null:new Response('Unauthorized',{status:401});
 new Function('Deno','fetch','denyUnlessAuthorized','drainDeliveries','webpush',js)(Deno,fetcher,deny,drainDeliveries,webpush);
 return handler;
}
for(const name of ['push-send','push-dispatch','fill-content','fetch-proxy']) {
 test(`${name} rejects public invocation before any database or external request`,async()=>{
  let calls=0;const handler=await load(name,async()=>{calls++;throw Error('must not fetch');});
  const res=await handler(new Request('https://functions.test/?url=https://news.test',{method:'POST',headers:{authorization:'Bearer anon'}}));
  assert.equal(res.status,401);assert.equal(calls,0);
 });
}
test('public VAPID setup never initializes missing keys',async()=>{
 const writes=[];const handler=await load('push-send',async(url,init)=>{if(init.method&&init.method!=='GET')writes.push(url);return Response.json([]);});
 const res=await handler(new Request('https://functions.test/?setup=1'));
 assert.equal((await res.json()).ok,false);assert.deepEqual(writes,[]);
});

test('authorized manual push handles empty successful enqueue response',async()=>{
 const handler=await load('push-send',async(url)=>{
  if(url.includes('secrets?'))return Response.json([{data:{publicJwk:{},privateJwk:{},publicKeyB64:'public'}}]);
  if(url.includes('push_subs?'))return Response.json([{profile:'owner'}]);
  if(url.includes('audit_enqueue_push'))return new Response(null,{status:204});
  if(url.includes('audit_claim_push'))return Response.json([]);
  throw new Error('unexpected request');
 },{importVapidKeys:async()=>({}),ApplicationServer:{new:async()=>({})}});
 const res=await handler(new Request('https://functions.test/',{method:'POST',headers:{'x-audit-secret':'server-secret','content-type':'application/json'},body:JSON.stringify({title:'Test'})}));
 assert.equal((await res.json()).ok,true);
});
