const safeKeys = new Set(['saved','read','seen','learnedTerms','starEvents','theme','look','textScale','watchPlayers','notifications']);
const actions = new Set(['list','login','create','load','patch','meta','subscription','logout']);
const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store','Content-Type':'application/json'};
const reply = (body,status=200) => new Response(JSON.stringify(body),{status,headers:cors});
const object = x => x && typeof x==='object' && !Array.isArray(x);
export async function handleProfile(req,rpc) {
 if(req.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
 if(req.method!=='POST') return reply({error:'method_not_allowed'},405);
 let b;
 try { const raw=await req.text(); if(raw.length>262144) return reply({error:'too_large'},413); b=JSON.parse(raw); } catch {return reply({error:'invalid_json'},400);}
 if(!object(b)||!actions.has(b.action)) return reply({error:'invalid_action'},400);
 if(b.action!=='list' && (typeof b.profile!=='string'|| !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(b.profile)||b.profile.length>64||b.profile==='guest')) return reply({error:'invalid_profile'},400);
 if(!['list','login','create'].includes(b.action) && !/^[a-f0-9]{64}$/.test(b.token||'')) return reply({error:'unauthorized'},401);
 if(['create','meta'].includes(b.action) && (typeof b.name!=='string'||!b.name.trim()||b.name.length>80||!/^#[a-f0-9]{6}$/i.test(b.color||''))) return reply({error:'invalid_metadata'},400);
 if('pin' in b && b.pin!==null && !/^\d{4}$/.test(typeof b.pin==='string'?b.pin:'')) return reply({error:'invalid_pin'},400);
 if(b.action==='patch' && (!object(b.changes)||Object.keys(b.changes).some(k=>!safeKeys.has(k)))) return reply({error:'invalid_changes'},400);
 if(b.action==='subscription') {
  try {if(!object(b.sub)||new URL(b.sub.endpoint).protocol!=='https:'||!object(b.sub.keys)||typeof b.sub.keys.p256dh!=='string'||typeof b.sub.keys.auth!=='string'||b.sub.endpoint.length>4096) throw Error();} catch {return reply({error:'invalid_subscription'},400);}
  if('disabled' in b && typeof b.disabled!=='boolean') return reply({error:'invalid_subscription'},400);
 }
 try {
  const {data,error}=await rpc(b);
  if(error||!data) return reply({error:'server_error'},500);
  if(data.error) return reply({error:data.error},data.status||400);
  return reply(data);
 } catch {return reply({error:'server_error'},500);}
}
