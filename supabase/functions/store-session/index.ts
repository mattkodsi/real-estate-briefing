// Only private pipeline authority can issue a ten-minute, single-use capture ticket.
// A reader profile or publishable key is never authority over the cookie vault.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { authorized } from '../_shared/audit-auth.mjs';
import { validateCapture, captureAuthorized, hashToken } from '../_shared/session-capture.mjs';
import { checkedFetch } from '../_shared/backend-policy.mjs';
const HEADERS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-audit-secret','Content-Type':'application/json','Cache-Control':'no-store'};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:HEADERS});
async function rpc(name:string,body:unknown){
 const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
 const r=await checkedFetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/rpc/${name}`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
 return await r.json();
}
Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return new Response(null,{headers:HEADERS});
 if(req.method!=='POST')return json({ok:false,error:'POST required'},405);
 try {
  // Bound actual body bytes even when Content-Length is omitted.
  const reader=req.body?.getReader();let bytes=0;const chunks:Uint8Array[]=[];
  if(reader){while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>40000){await reader.cancel();return json({ok:false,error:'Request too large'},413);}chunks.push(value);}}
  const buf=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buf.set(chunk,offset);offset+=chunk.length;}
  const body=JSON.parse(new TextDecoder().decode(buf));
  const secret=Deno.env.get('AUDIT_PIPELINE_SECRET');
  if(body.action==='issue-ticket'){
   if(!authorized(req,secret))return json({ok:false,error:'Unauthorized'},401);
   const {domain}=validateCapture(body,false);
   const token=[...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,'0')).join('');
   await rpc('issue_capture_ticket',{p_hash:await hashToken(token),p_domain:domain});
   return json({ok:true,domain,captureToken:token,expiresIn:600});
  }
  const {domain,cookie}=validateCapture(body);
  let saved=false;
  const allowed=await captureAuthorized(req,secret,body,async(token:string)=>{
   saved=await rpc('capture_publisher_session',{p_hash:await hashToken(token),p_domain:domain,p_cookie:cookie});return saved;
  });
  if(!allowed)return json({ok:false,error:'A valid owner capture ticket is required'},401);
  if(!saved)await rpc('capture_publisher_session',{p_hash:null,p_domain:domain,p_cookie:cookie});
  return json({ok:true,domain,cookieLen:cookie.length});
 }catch(e){
  return json({ok:false,error:e instanceof SyntaxError ? 'Invalid request' : 'Capture failed; check publisher, cookie and owner authorization'},400);
 }
});
