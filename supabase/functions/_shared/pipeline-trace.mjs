// Private, bounded, best-effort instrumentation. Never forward raw exceptions or content.
const token = /^[A-Za-z0-9_.:/-]{1,200}$/;
const safeToken=value=>typeof value === "string" && token.test(value) && !value.includes("://");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function sanitizeEvent(input) {
  if (!input || !uuid.test(input.id || '')) throw new Error('Invalid event');
  input={...input,entity_type:input.entity_type ?? 'run',entity_key:input.entity_key ?? input.run_id};
  const out = {id:input.id};
  for (const key of ['run_id','producer','stage','status','entity_type','entity_key']) {
    if (!safeToken(input[key])) throw new Error('Invalid event');
    out[key]=input[key];
  }
  if (!['started','completed','failed','skipped','conflict','retry','degraded','running'].includes(out.status)) throw new Error('Invalid status');
  if (input.observed_at != null) {
    if(typeof input.observed_at !== 'string' || !Number.isFinite(Date.parse(input.observed_at))) throw new Error('Invalid timestamp');
    out.observed_at=new Date(input.observed_at).toISOString();
  }
  out.details={};
  for(const [key,value] of Object.entries(input.details || {})) {
    if ((/^[a-z_]+_count$/.test(key) || ['count','attempt','attempts','duration_ms','filled','failed','words','exit_code','attempted','skipped'].includes(key)) && typeof value==='number' && Number.isFinite(value) && value>=-1 && value<=1e12) out.details[key]=value;
    if(['mode','phase','git_sha','external_run_id','parent_run_id','error_type','span_id','parent_span_id','reason','executor','environment','method','provider','model','workflow','artifact_type','trigger','retry_reason'].includes(key) && safeToken(value)) out.details[key]=value;
    if(['source_hash','artifact_hash','input_hash'].includes(key) && typeof value==='string' && /^[0-9a-f]{64}$/i.test(value)) out.details[key]=value;
    if(key==='receipt_at' && typeof value==='string' && /^\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))) out.details[key]=new Date(value).toISOString();
  }
  return out;
}
export async function bounded(operation, timeoutMs=1500) {
  const controller=new AbortController();let timer;
  try {
    return await Promise.race([Promise.resolve().then(()=>operation(controller.signal)),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Trace timeout'));},timeoutMs);})]);
  } finally {clearTimeout(timer);}
}
export function createPipelineTrace({sb,producer,runId=crypto.randomUUID(),timeoutMs=1500,warn=message=>console.warn(message)}) {
  let unavailable=false; // One failed sink must not add a timeout to every remaining stage.
  return {runId, async emit(stage,status,{entity_type='run',entity_key=runId,details={}}={}) {
    if(unavailable)return;
    try {
      const context={executor:'supabase-edge',environment:'supabase-edge',method:({'article.fetch':'safeFetch-http','article.parse':'html-parser','publication.write':'compare-and-swap'})[stage] || 'edge-handler',...details};
      const event=sanitizeEvent({id:crypto.randomUUID(),observed_at:new Date().toISOString(),run_id:runId,producer,stage,status,entity_type,entity_key,details:context});
      await bounded(async signal=>{
        const result=await sb('rpc/pipeline_record_events',{method:'POST',body:JSON.stringify({p_events:[event]}),signal});
        if(!result.ok) throw new Error('Trace unavailable');
        await result.text();
      },timeoutMs);
    } catch {unavailable=true;try {warn('Pipeline trace unavailable');} catch { /* preserve pipeline */ }}
  }};
}
