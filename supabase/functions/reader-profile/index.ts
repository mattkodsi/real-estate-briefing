import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleProfile } from './handler.mjs';
const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
Deno.serve((req:Request)=>handleProfile(req,(body:unknown)=>db.rpc('reader_profile_api',{
 payload:body,
 // Supabase's gateway supplies the connecting address. Do not accept an IP in JSON.
 client_ip:req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()||'unknown',
})));
