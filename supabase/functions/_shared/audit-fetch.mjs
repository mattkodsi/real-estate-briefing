import {Buffer} from 'node:buffer';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import http from 'node:http';
import https from 'node:https';

export function publicAddress(address) {
 const ip=address.toLowerCase().replace(/^\[|\]$/g,'');
 if(isIP(ip)===4) {
  const [a,b,c]=ip.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===192&&b===0||a===192&&b===2||a===192&&b===88&&c===99||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
 }
 // Allow global unicast only, excluding IPv4 translation/tunnel and documentation ranges.
 if(isIP(ip)!==6) return false;
 const words=ip.split(':'); const first=parseInt(words[0],16);
 return first>=0x2000 && first<=0x3fff && first!==0x2002 && !(first===0x2001 && parseInt(words[1]||'0',16)<0x200) && !(first===0x2001 && parseInt(words[1]||'0',16)===0xdb8) && !ip.startsWith('3fff:');
}
async function resolvePublic(host) {
 return (await lookup(host,{all:true,verbatim:true})).map(r=>r.address);
}
// Node-only transport that pins the socket to the validated IP while retaining the
// hostname for Host/TLS SNI. RETAINED for the Node test suite (real loopback
// pinning checks); NOT used in the hosted Supabase Deno edge runtime, where
// node:http/node:https connect-by-IP raises "error sending request" and mangles
// bracketless IPv6 hosts. The Deno path uses nativeRequest below.
export function pinnedRequest(url, {address,headers,signal,maxBytes}) {
 return new Promise((resolve,reject)=>{
  const transport=url.protocol==='https:'?https:http;
  const req=transport.request(url,{method:'GET',hostname:address,servername:url.hostname.replace(/^\[|\]$/g,''),
   headers:{...headers,Host:url.host},signal,agent:false},res=>{
   const chunks=[];let size=0;
   if(Number(res.headers['content-length'])>maxBytes) {res.destroy();reject(new Error('body limit'));return;}
   res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){res.destroy(new Error('body limit'));return;}chunks.push(chunk);});
   res.on('error',reject);
   res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString('utf8')}));
  });req.on('error',reject);req.end();
 });
}
// Deno-native transport for the edge runtime. SSRF safety is enforced by
// safeFetch, which resolves the host and rejects ANY non-public IP on EVERY hop
// BEFORE this runs, plus scheme/port/credential/host checks; this performs one
// non-redirecting fetch with a streamed body cap. Residual vs. pinnedRequest: it
// connects by hostname (a re-resolve by the runtime), leaving a narrow
// DNS-rebinding TOCTOU window — acceptable for this proxy's curated
// publisher-URL inputs and noted in docs/backend-audit.md.
export async function nativeRequest(url, {headers, signal, maxBytes}) {
 const h={...headers}; delete h['Accept-Encoding']; // forbidden for fetch; Deno auto-decodes anyway
 const res=await fetch(url.href,{method:'GET',headers:h,redirect:'manual',signal});
 const cl=Number(res.headers.get('content-length'));
 if(cl&&cl>maxBytes){try{await res.body?.cancel();}catch{} throw new Error('body limit');}
 let size=0; const chunks=[]; const reader=res.body?.getReader?.();
 if(reader){
  for(;;){
   const {done,value}=await reader.read();
   if(done)break;
   size+=value.length;
   if(size>maxBytes){try{await reader.cancel();}catch{} throw new Error('body limit');}
   chunks.push(value);
  }
 }
 const total=new Uint8Array(size); let off=0; for(const c of chunks){total.set(c,off);off+=c.length;}
 const out={}; res.headers.forEach((v,k)=>{out[k]=v;}); // lowercased plain object (res.headers.location etc.)
 return {status:res.status,headers:out,body:new TextDecoder('utf-8').decode(total)};
}
// Pick the transport that actually works in the current runtime.
const defaultRequest=(typeof Deno!=='undefined')?nativeRequest:pinnedRequest;
export async function safeFetch(target, options={}) {
 const {resolve=resolvePublic,request=defaultRequest,cookie=null,maxBytes=6_000_000,timeoutMs=15000}=options;
 let url=new URL(target);const initialHost=url.hostname;const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(new Error('fetch timeout')),timeoutMs);
 const aborted=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}));
 try {
  for(let hop=0;hop<=5;hop++) {
   if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port&&!['80','443'].includes(url.port)) throw new Error('blocked URL');
   const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
   if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||!host.includes('.')&&!isIP(host)) throw new Error('blocked host');
   const addresses=isIP(host)?[host]:await Promise.race([resolve(host),aborted]);
   if(!addresses.length||addresses.some(a=>!publicAddress(a))) throw new Error('blocked address');
   const headers={'User-Agent':'Mozilla/5.0','Accept':'text/html,application/xhtml+xml','Accept-Encoding':'identity'};
   if(cookie&&url.hostname===initialHost&&url.protocol==='https:') headers.Cookie=cookie;
   const res=await Promise.race([request(url,{address:addresses[0],headers,signal:controller.signal,maxBytes}),aborted]);
   if([301,302,303,307,308].includes(res.status)&&res.headers.location) {url=new URL(res.headers.location,url);continue;}
   return {ok:res.status>=200&&res.status<300,status:res.status,finalUrl:url.href,html:res.body};
  } throw new Error('redirect limit');
 } finally {clearTimeout(timer);}
}
