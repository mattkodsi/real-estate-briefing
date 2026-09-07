// Dedicated server-to-server credential; publishable JWTs are not authority.
export function authorized(req, secret) {
 const supplied=req.headers.get('x-audit-secret') || '';
 if(!secret || supplied.length!==secret.length) return false;
 let different=0; for(let i=0;i<secret.length;i++) different |= supplied.charCodeAt(i)^secret.charCodeAt(i);
 return different===0;
}
export function denyUnlessAuthorized(req) {
 return authorized(req, Deno.env.get('AUDIT_PIPELINE_SECRET')) ? null :
 new Response(JSON.stringify({ok:false,error:'Unauthorized'}),{status:401,headers:{'Content-Type':'application/json'}});
}
