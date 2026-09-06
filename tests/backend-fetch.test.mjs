import test from 'node:test';
import assert from 'node:assert/strict';
import {safeFetch, publicAddress} from '../supabase/functions/_shared/audit-fetch.mjs';
import {authorized} from '../supabase/functions/_shared/audit-auth.mjs';
test('reject private and reserved IP forms', () => {
 for(const ip of ['127.0.0.1','10.0.0.1','100.64.0.1','169.254.169.254','192.168.1.1','172.31.1.1','0.0.0.0','224.1.2.3','::1','::','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1']) assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('8.8.8.8'),true); assert.equal(publicAddress('2606:4700:4700::1111'),true);
});
test('DNS private answer and redirect to metadata never reach transport', async () => {
 let calls=0;
 await assert.rejects(safeFetch('https://news.test',{resolve:async()=>['10.0.0.1'],request:async()=>{calls++;}}));
 assert.equal(calls,0);
 await assert.rejects(safeFetch('https://news.test',{resolve:async()=>['8.8.8.8'],request:async()=>{calls++;return {status:302,headers:{location:'http://169.254.169.254/'},body:''};}}));
 assert.equal(calls,1);
});
test('redirects revalidate DNS and never transfer cookies to another host',async()=>{
 const seen=[]; const result=await safeFetch('https://news.test/a',{cookie:'subscriber=secret',resolve:async()=>['8.8.8.8'],request:async(u,o)=>{seen.push([u.href,o]);return seen.length===1?{status:302,headers:{location:'https://other.test/b'},body:''}:{status:200,headers:{},body:'article'};}});
 assert.equal(result.html,'article'); assert.equal(seen[0][1].headers.Cookie,'subscriber=secret'); assert.equal(seen[1][1].headers.Cookie,undefined); assert.equal(seen[1][1].address,'8.8.8.8');
});
test('auth fails closed and does not accept anonymous bearer',()=>{
 assert.equal(authorized(new Request('https://x'),''),false);
 assert.equal(authorized(new Request('https://x',{headers:{authorization:'Bearer public'}}),'secret'),false);
 assert.equal(authorized(new Request('https://x',{headers:{'x-audit-secret':'secret'}}),'secret'),true);
});
test('reject mixed public/private DNS, unsupported ports and credential URLs',async()=>{
 for(const url of ['https://news.test','https://news.test:444','https://user:pass@news.test'])
 await assert.rejects(safeFetch(url,{resolve:async()=>['8.8.8.8','::1'],request:async()=>{throw new Error('transport must not run');}}),/blocked/);
});
test('DNS and hanging transport share a bounded total deadline',async()=>{
 await assert.rejects(safeFetch('https://news.test',{timeoutMs:5,resolve:async()=>new Promise(()=>{})}),/timeout/);
 await assert.rejects(safeFetch('https://news.test',{timeoutMs:5,resolve:async()=>['8.8.8.8'],request:async()=>new Promise(()=>{})}),/timeout/);
});
test('redirect loops stop after bounded hops',async()=>{
 let calls=0;await assert.rejects(safeFetch('https://news.test',{resolve:async()=>['8.8.8.8'],request:async()=>{calls++;return {status:302,headers:{location:'/again'}};}}),/redirect limit/);assert.equal(calls,6);
});
