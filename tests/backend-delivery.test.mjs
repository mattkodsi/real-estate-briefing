import test from 'node:test';import assert from 'node:assert/strict';
import {drainDeliveries} from '../supabase/functions/_shared/audit-delivery.mjs';
test('permanent and temporary provider failures are recorded separately; successful devices complete once',async()=>{
 const jobs=[{id:1,claim_token:'a',sub:{}},{id:2,claim_token:'b',sub:{}},{id:3,claim_token:'c',sub:{}}];const outcomes=[];
 const rpc=async(name,data)=>name==='audit_claim_push'?(jobs.length?[jobs.shift()]:[]):outcomes.push(data);
 const result=await drainDeliveries(rpc,async(job)=>{if(job.id===2)throw {response:{status:503}};if(job.id===3)throw {response:{status:410}};});
 assert.deepEqual(outcomes.map(o=>o.p_outcome),['sent','retry','gone']);assert.equal(result.sent,1);assert.equal(result.failed,1);
});
test('database claim failure prevents all delivery',async()=>{
 let delivered=0;await assert.rejects(drainDeliveries(async()=>{throw new Error('DB unavailable');},async()=>{delivered++;}));assert.equal(delivered,0);
});
