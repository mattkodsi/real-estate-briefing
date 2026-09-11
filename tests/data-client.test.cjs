const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createDataClient}=require('../js/data-client.js');
test('concurrent callers share one in-flight response and failures remain retryable',async()=>{
 let calls=0,fail=true;
 const client=createDataClient({base:'https://test.invalid',key:'test',fetch:async()=>{calls++;await new Promise(r=>setTimeout(r,5));return new Response(JSON.stringify([{id:1}]),{status:fail?503:200});}});
 const results=await Promise.allSettled(Array.from({length:20},()=>client.read('players?select=data')));
 assert.equal(calls,1);assert(results.every(x=>x.status==='rejected'));
 fail=false;assert.equal((await client.read('players?select=data'))[0].id,1);assert.equal(calls,2);
});
test('pagination follows returned range even when server cap is smaller than requested',async()=>{
 const offsets=[];
 const client=createDataClient({base:'https://test.invalid',key:'test',fetch:async url=>{
  const off=Number(new URL(url).searchParams.get('offset'));offsets.push(off);
  return new Response(JSON.stringify(off===0?[{id:1},{id:2}]:off===2?[{id:3}]:[]),{headers:{'content-range':off===0?'0-1/3':'2-2/3'}});
 }});
 assert.equal((await client.all('players?select=data&order=slug.asc')).length,3);assert.deepEqual(offsets,[0,2]);
});
test('requests have a deadline that also covers stalled body reads',async()=>{
 const client=createDataClient({base:'https://test.invalid',key:'test',timeout:10,fetch:async()=>({ok:true,headers:new Headers(),json:()=>new Promise(()=>{})})});
 await assert.rejects(client.read('days'),/timed out/);
});
