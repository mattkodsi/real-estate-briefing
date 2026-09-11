import { handleReceipt } from './handler.mjs';
const url=Deno.env.get('SUPABASE_URL')!;
const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
Deno.serve((req:Request)=>handleReceipt(req,async(body:unknown)=>{
 const response=await fetch(`${url}/rest/v1/rpc/audit_observe_delivery`,{
  method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
  body:JSON.stringify(body),signal:AbortSignal.timeout(5000),
 });
 return {error:!response.ok};
}));
