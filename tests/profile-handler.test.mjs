import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleProfile} from '../supabase/functions/reader-profile/handler.mjs';
const mutation={id:'12345678-1234-4234-8234-123456789abc',sets:{read:{add:['a'],remove:['b']}}};
async function call(extra){let called=false;const response=await handleProfile(new Request('https://test',{method:'POST',body:JSON.stringify({action:'patch',profile:'one',token:'a'.repeat(64),changes:{},...extra})}),async()=>{called=true;return {data:{data:{}}}});return {status:response.status,called};}
test('valid set mutations accepted',async()=>assert.equal((await call({mutations:[mutation]})).status,200));
test('malformed mutations rejected before RPC',async()=>{for(const mutations of [null,{},[{...mutation,id:'bad'}],[{...mutation,sets:{pin:{add:[],remove:[]}}}],[{...mutation,sets:{read:{add:[1],remove:[]}}}],[{...mutation,sets:{saved:{add:[{key:'x'}],remove:[]}}}],[{...mutation,sets:{read:{add:[],remove:[3]}}}],[{...mutation,sets:{read:{add:[],remove:[],surprise:true}}}],[{...mutation,unknown:true}]])assert.deepEqual(await call({mutations}),{status:400,called:false});});
test('mutations cannot bypass session requirement or overlap replacements',async()=>{assert.equal((await call({token:'',mutations:[mutation]})).status,401);assert.equal((await call({changes:{read:[]},mutations:[mutation]})).status,400);});
