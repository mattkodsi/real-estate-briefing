const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
async function runFetch(response, cached, url='https://x.supabase.co/rest/v1/days?select=data'){
 const listeners={}, puts=[], waits=[];
 const cache={put:async(req,res)=>puts.push(await res.text()),match:async()=>cached,keys:async()=>[],delete:async()=>{}};
 const context={self:{addEventListener:(name,fn)=>listeners[name]=fn},URL,Response,Request,fetch:async()=>{if(response instanceof Error)throw response;return response},caches:{open:async()=>cache,match:async()=>cached},console};
 vm.runInNewContext(fs.readFileSync('sw.js','utf8'),context);
 let result;listeners.fetch({request:new Request(url),respondWith:p=>result=p,waitUntil:p=>waits.push(p)});
 const res=result ? await result : response;await Promise.all(waits);return {res,puts};
}
test('a server error cannot replace the last good offline briefing',async()=>{
 const {res,puts}=await runFetch(new Response('unavailable',{status:503}),new Response('good'));
 assert.equal(await res.text(),'good');assert.deepEqual(puts,[]);
});
test('successful data writes finish before offline save is reported',async()=>{
 const {res,puts}=await runFetch(new Response('fresh'),new Response('old'));
 assert.equal(await res.text(),'fresh');assert.deepEqual(puts,['fresh']);
});
test('auth failures stay visible and private reads are never cached',async()=>{
 const {res,puts}=await runFetch(new Response('private',{status:401}),new Response('old'),'https://x.supabase.co/rest/v1/prefs');
 assert.equal(res.status,401);assert.deepEqual(puts,[]);
});
async function legacyFetch(query, entries, network=new Error('offline')) {
 const listeners={}, cache={keys:async()=>entries.map(([url])=>new Request(url)),match:async req=>{const url=typeof req==='string'?req:req.url;const entry=entries.find(([key])=>key===url);return entry?new Response(JSON.stringify(entry[1]),{status:entry[2]||200,headers:{'content-type':'application/json'}}):undefined;},put:async()=>{}};
 const context={self:{addEventListener:(name,fn)=>listeners[name]=fn},URL,URLSearchParams,Response,Request,fetch:async()=>{if(network instanceof Error)throw network;return network;},caches:{open:async()=>cache,match:cache.match},console};
 vm.runInNewContext(fs.readFileSync('sw.js','utf8'),context);
 let result;listeners.fetch({request:new Request('https://x.supabase.co/rest/v1/'+query),respondWith:p=>result=p,waitUntil:()=>{}});return await result;
}
test('offline upgrade pages and sorts one matching legacy collection snapshot',async()=>{
 const entries=[['https://x.supabase.co/rest/v1/players?select=slug,data',[{slug:'c',data:{}},{slug:'a',data:{}},{slug:'b',data:{}}]]];
 const first=await legacyFetch('players?select=slug,data&order=slug.asc&limit=2&offset=0',entries);
 assert.equal(first.status,200);assert.deepEqual((await first.json()).map(r=>r.slug),['a','b']);assert.equal(first.headers.get('content-range'),'0-1/3');
 const last=await legacyFetch('players?select=slug,data&order=slug.asc&limit=2&offset=2',entries,new Response('bad',{status:503}));
 assert.deepEqual((await last.json()).map(r=>r.slug),['c']);assert.equal(last.headers.get('content-range'),'2-2/3');
});
test('legacy fallback cannot substitute other filters, projections, private data or partial pages',async()=>{
 const entries=[['https://x.supabase.co/rest/v1/days_light?select=data&date=eq.2026-09-10',[{date:'2026-09-10'}]],['https://x.supabase.co/rest/v1/players?select=slug,data&limit=500&offset=0',[{slug:'a'}]],['https://x.supabase.co/rest/v1/terms?select=slug,data',[{slug:'x'}],503]];
 for(const query of ['days_light?select=data&date=eq.2026-09-11&order=date.desc&limit=500&offset=0','days_light?select=date,data&date=eq.2026-09-10&limit=500&offset=0','players?select=slug,data&limit=500&offset=500','terms?select=slug,data&limit=500&offset=0'])assert.notEqual((await legacyFetch(query,entries)).status,200);
 const unauthorized=await legacyFetch('days_light?select=data&date=eq.2026-09-10&limit=500&offset=0',entries,new Response('no',{status:401}));assert.equal(unauthorized.status,401);
});
test('legacy collection range lets the real paginated client terminate',async()=>{
 const {createDataClient}=require('../js/data-client.js');let calls=0;
 const entries=[['https://x.supabase.co/rest/v1/players?select=slug,data',[{slug:'b'},{slug:'a'}]]];
 const client=createDataClient({base:'https://x.supabase.co',key:'public',fetch:async url=>{assert(++calls<3);return legacyFetch(url.split('/rest/v1/')[1],entries);}});
 assert.deepEqual((await client.all('players?select=slug,data&order=slug.asc')).map(r=>r.slug),['a','b']);assert.equal(calls,1);
 const limited=await legacyFetch('players?select=slug,data&order=slug.asc&limit=500&offset=0',entries,new Response('wait',{status:429}));assert.equal(limited.status,429);
});
test('ambiguous legacy snapshots are not mixed or guessed',async()=>{
 const entries=[['https://x.supabase.co/rest/v1/players?select=slug,data',[{slug:'a'}]],['https://x.supabase.co/rest/v1/players?select=slug,data&order=slug.desc',[{slug:'b'}]]];
 assert.notEqual((await legacyFetch('players?select=slug,data&order=slug.asc&limit=500&offset=0',entries)).status,200);
});
