import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('../supabase/functions/reader-profile/handler.mjs').catch(() => ({}));
const handle = module.handleProfile;
test('profile API exists', () => assert.equal(typeof handle,'function'));
const call = (body, rpc=async()=>({data:{data:{saved:[]}}})) => handle(new Request('https://example.test',{method:'POST',body:JSON.stringify(body)}),rpc);
test('invalid slug and security patches rejected before DB',async()=>{
 for(const body of [{action:'load',profile:'../x',token:'a'.repeat(64)},{action:'patch',profile:'amy',token:'a'.repeat(64),changes:{pinHash:'oops'}},{action:'create',profile:'amy',name:'Amy',color:'#ffffff',pin:'123'}]) {
 assert.equal((await call(body,()=>{throw Error('DB must not run')})).status,400);
 }
});
test('missing session rejected',async()=>assert.equal((await call({action:'load',profile:'amy'})).status,401));
test('DB authorization failure remains unauthorized',async()=>assert.equal((await call({action:'load',profile:'amy',token:'a'.repeat(64)},async()=>({data:{error:'unauthorized',status:401}}))).status,401));
test('patch forwards only validated request and returns saved data',async()=>{
 const response=await call({action:'patch',profile:'amy',token:'a'.repeat(64),changes:{saved:[{key:'2026-09-06/one',date:'2026-09-06',id:'one',title:'One'}]}});
 assert.deepEqual(await response.json(),{data:{saved:[]}});
});
test('subscription rejects insecure or malformed endpoint',async()=>{
 assert.equal((await call({action:'subscription',profile:'amy',token:'a'.repeat(64),sub:{endpoint:'http://example.com'}})).status,400);
});
test('preference types cannot corrupt reader collections or settings',async()=>{
 for(const changes of [{saved:'foo'},{read:{}},{saved:[null]},{read:[3]},{notifications:{breaking:'false'}},{seen:[]},{theme:'arbitrary'},{textScale:'xxl'}]) {
  assert.equal((await call({action:'patch',profile:'amy',token:'a'.repeat(64),changes})).status,400,JSON.stringify(changes));
 }
});
test('full 800-item read history and a substantial bookmark collection fit',async()=>{
 const changes={read:Array.from({length:800},(_,i)=>`2026-09-06/${i}`),saved:Array.from({length:1200},(_,i)=>({key:`2026-09-06/${i}`,date:'2026-09-06',id:String(i),title:'Bookmark title '.repeat(20)}))};
 assert.equal((await call({action:'patch',profile:'amy',token:'a'.repeat(64),changes})).status,200);
});
