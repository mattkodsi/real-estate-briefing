const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createProfileStore}=require('../js/profile-store.js');
const storage=()=>{const m=new Map();return {get length(){return m.size},key:i=>[...m.keys()][i]??null,getItem:k=>m.get(k),setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)}};
// Transport fixture models atomic server set operations and durable receipts.
function server(){let data={read:['old']};const ids=new Set();return {get:()=>structuredClone(data),send:async(slug,changes,mutations=[])=>{data={...data,...changes};for(const m of mutations){if(ids.has(m.id))continue;ids.add(m.id);for(const [k,d]of Object.entries(m.sets)){const by=new Map((data[k]||[]).map(x=>[k==='saved'?x.key:x,x]));d.remove.forEach(x=>by.delete(x));d.add.forEach(x=>by.set(k==='saved'?x.key:x,x));data[k]=[...by.values()];}}return structuredClone(data);}};}
test('two stale devices retain independent additions and offline removals',async()=>{const s=server();const a=createProfileStore(storage(),s.send),b=createProfileStore(storage(),s.send);a.observe('one',s.get());b.observe('one',s.get());a.enqueue('one','read',['old','a']);b.enqueue('one','read',['b']);await a.flush('one');await b.flush('one');assert.deepEqual(s.get().read.sort(),['a','b']);});
test('lost response retry cannot resurrect item another device subsequently removed',async()=>{const s=server(),disk=storage();let fail=true;const a=createProfileStore(disk,async(...args)=>{const d=await s.send(...args);if(fail){fail=false;throw Error('lost response');}return d;});a.observe('one',s.get());a.enqueue('one','read',['old','a']);await assert.rejects(a.flush('one'));const b=createProfileStore(storage(),s.send);b.observe('one',s.get());b.enqueue('one','read',['old']);await b.flush('one');const restarted=createProfileStore(disk,s.send);restarted.observe('one',s.get());await restarted.flush('one');assert.deepEqual(s.get().read,['old']);});
test('edits during an in-flight send survive its acknowledgment',async()=>{const s=server();let release;const a=createProfileStore(storage(),async(...args)=>{const result=await s.send(...args);await new Promise(r=>release=r);return result;});a.observe('one',s.get());a.enqueue('one','read',['old','a']);const pending=a.flush('one');await new Promise(setImmediate);a.enqueue('one','read',['old','b']);release();await new Promise(setImmediate);release();await pending;assert.deepEqual(s.get().read.sort(),['b','old']);});
test('overlay rebases pending additions onto remote changes',()=>{const a=createProfileStore(storage(),async()=>{});a.observe('one',{read:[]});a.enqueue('one','read',['local']);assert.deepEqual(a.overlay('one',{read:['remote']}).read,['remote','local']);});
test('saved story deltas use stable keys and retain other-device bookmarks',async()=>{const s=server(),a=createProfileStore(storage(),s.send),b=createProfileStore(storage(),s.send);const story=key=>({key,date:'2026-09-11',id:key,title:key});a.observe('one',{saved:[]});b.observe('one',{saved:[]});a.enqueue('one','saved',[story('a')]);b.enqueue('one','saved',[story('b')]);await a.flush('one');await b.flush('one');assert.deepEqual(s.get().saved.map(x=>x.key),['a','b']);});
test('legacy pending snapshots survive upgrade and new edits survive storage failure',async()=>{const s=server(),disk=storage();disk.setItem('briefing_pending_v2_one',JSON.stringify({read:{value:['legacy'],revision:3}}));const a=createProfileStore(disk,s.send);a.observe('one',s.get());await a.flush('one');assert.deepEqual(s.get().read,['legacy']);disk.setItem=()=>{throw Error('quota')};assert.throws(()=>a.enqueue('one','read',['legacy','new']));await a.flush('one');assert.deepEqual(s.get().read,['legacy','new']);});
test('two offline tabs retain both journals after reopening',async()=>{
 const disk=storage(),s=server(),a=createProfileStore(disk,s.send),b=createProfileStore(disk,s.send);
 a.observe('one',s.get());b.observe('one',s.get());
 a.enqueue('one','read',['old','a']);b.enqueue('one','read',['old','b']);
 const reopened=createProfileStore(disk,s.send);
 assert.deepEqual(reopened.overlay('one',s.get()).read.sort(),['a','b','old']);
 await reopened.flush('one');assert.deepEqual(s.get().read.sort(),['a','b','old']);
});
test('stale tab does not resurrect operations acknowledged by another tab',async()=>{
 const disk=storage(),s=server(),a=createProfileStore(disk,s.send),b=createProfileStore(disk,s.send);
 a.observe('one',s.get());a.enqueue('one','theme','dark');b.observe('one',s.get());
 await a.flush('one');a.enqueue('one','theme','light');await a.flush('one');
 b.enqueue('one','read',['old','b']);await b.flush('one');
 assert.equal(s.get().theme,'light');
});
test('cross-tab locks serialize scalar sends and acknowledge only their operation keys',async()=>{
 const disk=storage(),s=server();let tail=Promise.resolve(),lockCalls=0,sends=0,release;
 const locks={request:(name,run)=>{lockCalls++;const next=tail.then(run);tail=next.catch(()=>{});return next;}};
 const send=async(...args)=>{sends++;if(sends===1)await new Promise(r=>release=r);return s.send(...args);};
 const a=createProfileStore(disk,send,()=>{},locks),b=createProfileStore(disk,send,()=>{},locks);
 a.observe('one',s.get());b.observe('one',s.get());a.enqueue('one','theme','dark');
 const first=a.flush('one');await new Promise(setImmediate);
 b.enqueue('one','theme','light');const second=b.flush('one');
 release();await Promise.all([first,second]);
 assert.equal(lockCalls,2);assert.equal(sends,2);assert.equal(s.get().theme,'light');
 assert.equal(disk.length,0);
});
test('v3 journal migration preserves operation IDs for response-loss receipts',async()=>{
 const disk=storage(),id='12345678-1234-1234-1234-123456789abc';
 disk.setItem('briefing_pending_v3_one',JSON.stringify([{id,changes:{},sets:{read:{add:['a'],remove:[]}}}]));
 let sent;
 const a=createProfileStore(disk,async(slug,changes,mutations)=>{sent=mutations;return {read:['a']};});
 a.observe('one',{read:[]});await a.flush('one');
 assert.equal(sent[0].id,id);assert.equal(disk.length,0);
});
