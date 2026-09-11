import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {drainDeliveries} from '../supabase/functions/_shared/audit-delivery.mjs';
const token='11111111-1111-4111-8111-111111111111';

test('receipt database accepts only attempted recent jobs with token and preserves first observation',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');const db=new PGlite();
 try {
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create table audit_push_jobs(id bigint primary key,attempts int,created_at timestamptz default now());
    insert into audit_push_jobs values(1,1,now()),(2,0,now()),(3,1,now()-interval '8 days');`);
  await db.exec(await readFile(new URL('../supabase/migrations/20260911175645_device_delivery_receipts.sql',import.meta.url),'utf8'));
  let row=(await db.query('select * from audit_push_jobs where id=1')).rows[0];
  assert.ok(row.receipt_token);assert.equal(row.device_received_at,null);assert.equal(row.device_displayed_at,null);
  await db.query('update audit_push_jobs set receipt_token=$1',[token]);
  for(const [id,proof] of [[1,'22222222-2222-4222-8222-222222222222'],[2,token],[3,token],[404,token]]) {
   await db.query("select audit_observe_delivery($1,$2,'received')",[id,proof]);
  }
  assert.equal((await db.query('select count(*)::int n from audit_push_jobs where device_received_at is not null')).rows[0].n,0);
  for(const role of ['anon','authenticated']) {
   await db.exec('set role '+role);
   await assert.rejects(()=>db.query("select audit_observe_delivery(1,$1,'received')",[token]),/permission denied/);
   await db.exec('reset role');
  }
  await db.exec('set role service_role');
  await db.query("select audit_observe_delivery(1,$1,'received')",[token]);
  await db.exec('reset role');
  row=(await db.query('select * from audit_push_jobs where id=1')).rows[0];
  assert.ok(row.device_received_at);assert.equal(row.device_displayed_at,null);
  await db.query("select audit_observe_delivery(1,$1,'received')",[token]);
  assert.equal((await db.query('select device_received_at from audit_push_jobs where id=1')).rows[0].device_received_at.getTime(),row.device_received_at.getTime());
  await db.query("select audit_observe_delivery(1,$1,'displayed')",[token]);
  const displayed=(await db.query('select device_displayed_at from audit_push_jobs where id=1')).rows[0].device_displayed_at;
  assert.ok(displayed);
  await db.query("select audit_observe_delivery(1,$1,'displayed')",[token]);
  assert.equal((await db.query('select device_displayed_at from audit_push_jobs where id=1')).rows[0].device_displayed_at.getTime(),displayed.getTime());
  await db.query("select audit_observe_delivery(2,$1,'read')",[token]);
  assert.equal((await db.query('select device_displayed_at from audit_push_jobs where id=2')).rows[0].device_displayed_at,null);
 } finally {await db.close();}
});

test('delivery adds per-job proof only to outbound copy and reuses proof on retry',async()=>{
 const job={id:7,receipt_token:token,claim_token:token,payload:{title:'Story',tag:'same'}};
 const sent=[];let claims=0;
 const rpc=async(name)=>name==='audit_claim_push'?(claims++<2?[job]:[]):[];
 await drainDeliveries(rpc,async outgoing=>sent.push(outgoing));
 assert.deepEqual(sent.map(x=>x.payload.receipt),[{id:'7',token},{id:'7',token}]);
 assert.equal(job.payload.receipt,undefined);assert.equal(sent[0].payload.tag,'same');
});

test('receipt handler bounds input and never reveals whether a job/token matched',async()=>{
 const {handleReceipt}=await import('../supabase/functions/delivery-receipt/handler.mjs');
 let calls=0;const rpc=async()=>{calls++;return {data:null,error:null}};
 const request=body=>new Request('https://local',{method:'POST',body:typeof body==='string'?body:JSON.stringify(body)});
 for(const body of ['{',{}, {id:'1',token,stage:'read'}, {id:'1',token,stage:'received',profile:'private'}, {id:'-1',token,stage:'received'}]) {
  assert.equal((await handleReceipt(request(body),rpc)).status,400);
 }
 assert.equal((await handleReceipt(request('x'.repeat(4097)),rpc)).status,413);assert.equal(calls,0);
 for(const id of ['1','404']) {
  const response=await handleReceipt(request({id,token,stage:'received'}),rpc);
  assert.equal(response.status,202);assert.deepEqual(await response.json(),{accepted:true});
 }
 assert.equal((await handleReceipt(new Request('https://local'),rpc)).status,405);
});

async function pushHarness(fetchImpl, show=async()=>{}) {
 const handlers={},requests=[],shown=[];
 const ctx={URL,AbortController,setTimeout,clearTimeout,Date,console,fetch:(url,options)=>{requests.push({url,...options});return fetchImpl(url,options)},self:{addEventListener:(name,fn)=>handlers[name]=fn,navigator:{},registration:{showNotification:async(...args)=>{shown.push(args);await show()}}}};
 vm.runInNewContext(await readFile(new URL('../sw.js',import.meta.url),'utf8'),ctx);
 return {requests,shown,async push(){const pending=[];handlers.push({data:{json:()=>({title:'Story',tag:'same',receipt:{id:'7',token,url:'https://evil.test'}})},waitUntil:p=>pending.push(p)});return Promise.allSettled(pending)}};
}

test('failed receipts cannot block showing notification; endpoint is fixed and tag unchanged',async()=>{
 const h=await pushHarness(async()=>{throw Error('offline')});await h.push();
 assert.equal(h.shown.length,1);assert.equal(h.shown[0][1].tag,'same');
 assert.deepEqual(h.requests.map(x=>JSON.parse(x.body).stage),['received','displayed']);
 assert.ok(h.requests.every(x=>x.url==='https://uhwdnmbxiopfysodydty.supabase.co/functions/v1/delivery-receipt'));
});
test('display failure never reports displayed',async()=>{
 const h=await pushHarness(async()=>({ok:true}),async()=>{throw Error('permission denied')});await h.push();
 assert.deepEqual(h.requests.map(x=>JSON.parse(x.body).stage),['received']);
});

test('pending receipt network requests do not hold notification display',async()=>{
 let release;const blocked=new Promise(resolve=>{release=resolve});
 const h=await pushHarness(()=>blocked);
 const completion=h.push();
 for(let i=0;i<8;i++) await Promise.resolve();
 assert.equal(h.shown.length,1);
 release({ok:true});await completion;
});

test('redelivered payload keeps notification replacement tag and no renotify request',async()=>{
 const h=await pushHarness(async()=>({ok:true}));await h.push();await h.push();
 assert.equal(h.shown.length,2);
 assert.ok(h.shown.every(([,options])=>options.tag==='same'&&options.renotify!==true));
 assert.ok(h.shown.every(([,options])=>!('receipt' in options.data)));
});
