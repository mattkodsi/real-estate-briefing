// DB atomically owns one device lease at a time. A provider failure is never success.
export async function drainDeliveries(rpc, send, limit=40) {
 const result={sent:0,failed:0,pruned:0};
 for(let i=0;i<limit;i++) {
  const [job]=await rpc('audit_claim_push',{});if(!job)break;
  let outcome='sent';let error='';
  try {await send(job);} catch(e) {
   const status=e?.response?.status;
   outcome=status===404||status===410||e?.isGone?.()===true?'gone':'retry';
   error=String(e).slice(0,300);
  }
  // If this write fails, stop: do not send further jobs with unknown persistence.
  await rpc('audit_finish_push',{p_id:job.id,p_token:job.claim_token,p_outcome:outcome,p_error:error});
  result[outcome==='sent'?'sent':outcome==='gone'?'pruned':'failed']++;
 }
 return result;
}
