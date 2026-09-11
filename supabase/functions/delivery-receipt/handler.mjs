const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store','Content-Type':'application/json'};
const reply=(body,status)=>new Response(JSON.stringify(body),{status,headers:cors});
const maxBytes=4096;
export async function handleReceipt(req,rpc) {
 if(req.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
 if(req.method!=='POST') return reply({error:'method_not_allowed'},405);
 if(Number(req.headers.get('content-length'))>maxBytes) return reply({error:'too_large'},413);
 let body;
 try {
  const reader=req.body?.getReader();let size=0,raw='';const decoder=new TextDecoder();
  if(!reader) return reply({error:'invalid_body'},400);
  while(true) {
   const {done,value}=await reader.read();if(done)break;
   size+=value.byteLength;
   if(size>maxBytes){await reader.cancel();return reply({error:'too_large'},413);}
   raw+=decoder.decode(value,{stream:true});
  }
  body=JSON.parse(raw+decoder.decode());
 } catch {return reply({error:'invalid_body'},400);}
 if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).length!==3||
    typeof body.id!=='string'||! /^[1-9][0-9]{0,18}$/.test(body.id)||BigInt(body.id)>9223372036854775807n||
    typeof body.token!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.token)||
    !['received','displayed'].includes(body.stage)) return reply({error:'invalid_body'},400);
 try {
  const result=await rpc({p_id:body.id,p_token:body.token,p_stage:body.stage});
  if(result?.error) return reply({error:'unavailable'},503);
  return reply({accepted:true},202);
 } catch {return reply({error:'unavailable'},503);}
}
