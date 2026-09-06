import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {pinnedRequest} from '../supabase/functions/_shared/audit-fetch.mjs';
async function withServer(handler, run){
 const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{await run(server.address().port);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test('pinned transport uses validated address while retaining URL hostname',async()=>{
 await withServer((req,res)=>res.end(req.headers.host),async port=>{
 const result=await pinnedRequest(new URL(`http://unresolvable.invalid:${port}/`),{address:'127.0.0.1',headers:{},signal:new AbortController().signal,maxBytes:100});
 assert.equal(result.body,`unresolvable.invalid:${port}`);
 });
});
test('streaming transport rejects oversized body before buffering whole response',async()=>{
 await withServer((_req,res)=>{res.write('1234567890');res.end('extra');},async port=>{
 await assert.rejects(pinnedRequest(new URL(`http://unresolvable.invalid:${port}/`),{address:'127.0.0.1',headers:{},signal:new AbortController().signal,maxBytes:8}),/body limit/);
 });
});
