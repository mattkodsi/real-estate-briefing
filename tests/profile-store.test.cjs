const {test}=require('node:test');const assert=require('node:assert/strict');
const {createProfileStore}=require('../js/profile-store.js');
const storage=()=>{const map=new Map();return {getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)}};
test('offline pending bookmarks survive recreation and merge with fresh unrelated settings',async()=>{
 const disk=storage();const first=createProfileStore(disk,async()=>{throw Error('offline')});first.enqueue('a','saved',['story']);await assert.rejects(first.flush('a'));
 let written;const second=createProfileStore(disk,async(slug,changes)=>{written={slug,changes};return {theme:'dark',...changes}});
 assert.deepEqual(second.overlay('a',{theme:'dark',saved:[]}),{theme:'dark',saved:['story']});await second.flush('a');assert.deepEqual(written,{slug:'a',changes:{saved:['story']}});
});
test('a slow save cannot consume a newer edit or another readers data',async()=>{
 let release;const writes=[],saved=[];const store=createProfileStore(storage(),async(slug,changes)=>{writes.push({slug,changes});if(writes.length===1)await new Promise(r=>release=r);return changes},(slug,data)=>saved.push({slug,data}));
 store.enqueue('a','saved',['first']);const p=store.flush('a');store.enqueue('a','saved',['newest']);store.enqueue('b','saved',['other']);assert.equal(store.flush('a'),p);release();await p;
 assert.deepEqual(writes,[{slug:'a',changes:{saved:['first']}},{slug:'a',changes:{saved:['newest']}}]);assert.deepEqual(store.overlay('b',{}),{saved:['other']});assert.deepEqual(saved.at(-1),{slug:'a',data:{saved:['newest']}});
});
