/// <reference lib="dom" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { denyUnlessAuthorized } from "../_shared/audit-auth.mjs";
import { bounded, sanitizeEvent } from "../_shared/pipeline-trace.mjs";
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
async function readBody(req:Request, signal:AbortSignal) {
  if(Number(req.headers.get('content-length'))>131072) throw new Error('Invalid body');
  const reader=req.body?.getReader();if(!reader) throw new Error('Invalid body');
  const cancel=()=>{reader.cancel().catch(()=>{});};
  signal.addEventListener("abort",cancel,{once:true});
  let size=0;const chunks:Uint8Array[]=[];
  try {
    for(;;) {const {value,done}=await reader.read();if(done) break;size+=value.length;if(size>131072) throw new Error('Invalid body');chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {signal.removeEventListener("abort",cancel);reader.cancel().catch(()=>{});}
}
Deno.serve(async(req:Request)=>{
 const denied=denyUnlessAuthorized(req);if(denied)return denied;
 if(!['GET','POST'].includes(req.method))return json({ok:false,error:'Method not allowed'},405);
 let path:string,init:RequestInit={};let pageLimit=100;
 try {
  if(req.method==='POST') {
   const payload=await bounded(signal=>readBody(req,signal),3000);
   if(!Array.isArray(payload.events)||!payload.events.length||payload.events.length>100)throw Error('Invalid events');
   path='rpc/pipeline_record_events';init={method:'POST',body:JSON.stringify({p_events:payload.events.map(sanitizeEvent)})};
  } else {
   const params=new URL(req.url).searchParams;
   pageLimit=Math.min(500,Math.max(1,Math.floor(Number(params.get('limit')||100)||100)));
   const q=new URLSearchParams({select:'*',order:'recorded_at.asc,id.asc',limit:String(pageLimit)});
   const valid=(value:string)=>/^[A-Za-z0-9_.:/-]{1,200}$/.test(value) && !value.includes('://');
   const run=params.get('run_id'),type=params.get('entity_type'),key=params.get('entity_key'),since=params.get('since');
   if(run){if(!valid(run))throw Error();q.set('run_id','eq.'+run);}
   if(type||key){if(!type||!key||!valid(type)||!valid(key))throw Error();q.set('entity_type','eq.'+type);q.set('entity_key','eq.'+key);}
   if(since){if(!Number.isFinite(Date.parse(since)))throw Error();q.set('recorded_at','gte.'+new Date(since).toISOString());}
   if(!run&&!key&&!since)throw Error();
   const cursor=params.get('cursor');
   if(cursor) {
    if(cursor.length>500 || !/^[A-Za-z0-9_-]+$/.test(cursor))throw Error();
    const decoded=JSON.parse(atob(cursor.replace(/-/g,'+').replace(/_/g,'/')));
    if(typeof decoded.recorded_at!=='string' || !/^\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(decoded.recorded_at) || !Number.isFinite(Date.parse(decoded.recorded_at)) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded.id || ''))throw Error();
    // Retain database microseconds; JS Date conversion would lose cursor precision.
    q.set('or',`(recorded_at.gt.${decoded.recorded_at},and(recorded_at.eq.${decoded.recorded_at},id.gt.${decoded.id}))`);
   }
   path='pipeline_events?'+q;
  }
 } catch {return json({ok:false,error:'Invalid trace request'},400);}
 try {
  const data=await bounded(async signal=>{
   const response=await fetch(SB_URL+'/rest/v1/'+path,{...init,signal,headers:{apikey:SB_KEY,Authorization:'Bearer '+SB_KEY,'Content-Type':'application/json'}});
   if(!response.ok)throw Error();return await response.json();
  },5000);
  if(req.method==='GET') {
   if(!Array.isArray(data))throw Error();
   const last=data.at(-1);
   const next_cursor=data.length===pageLimit && last ? btoa(JSON.stringify({recorded_at:last.recorded_at,id:last.id})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'') : null;
   return json({ok:true,events:data,next_cursor});
  }
  return json({ok:true,inserted:data});
 } catch {return json({ok:false,error:'Trace storage unavailable'},503);}
});
