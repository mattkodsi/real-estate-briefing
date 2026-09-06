const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.join(__dirname,'..');
async function app({remembered=false,offline=false}={}){
 const errors=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>{if(!e.message.includes('navigation'))errors.push(e)});
 const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'https://briefing.test/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});const w=dom.window;
 w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});w.ResizeObserver=class{observe(){}disconnect(){}};w.IntersectionObserver=class{observe(){}disconnect(){}};w.scrollTo=()=>{};w.HTMLElement.prototype.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
 w.localStorage.setItem('briefing_prefs_inactive',JSON.stringify({pinHash:'legacy-verifier',pin:'1234',token:'old-token',saved:['keep']}));
 const data={name:'Alice',color:'#8a3b46',hasPin:true,saved:[],read:[]};const calls=[];
 if(remembered){w.localStorage.setItem('briefing_profile_v1','alice');w.localStorage.setItem('briefing_session_alice','a'.repeat(64));w.localStorage.setItem('briefing_prefs_alice',JSON.stringify(data));}
 w.fetch=async(url,options={})=>{const u=String(url);if(offline)throw Error('offline');if(u.includes('reader-profile')){
 const b=JSON.parse(options.body);calls.push(b);let body;
 if(b.action==='list')body={profiles:[{slug:'alice',name:'Alice',color:'#8a3b46',hasPin:true}]};
 else if(b.action==='login')body=b.pin==='1234'?{token:'a'.repeat(64),data}:{error:'unauthorized'};
 else if(b.action==='load')body=b.token?{data}:{error:'unauthorized'};
 else if(b.action==='patch'){Object.assign(data,b.changes);body={data};}
 else body={ok:true};return {ok:!body.error,status:body.error?401:200,json:async()=>JSON.parse(JSON.stringify(body))};}
 return {ok:true,json:async()=>[]};};
 w.eval(fs.readFileSync(path.join(root,'js/profile-store.js'),'utf8'));w.eval(fs.readFileSync(path.join(root,'js/app.js'),'utf8'));
 const settle=()=>new Promise(r=>setTimeout(r,80));await settle();return {dom,w,calls,errors,settle};
}
test('full app cold boot requires server PIN verification then opens briefing',async()=>{
 const t=await app();try{
 const card=t.w.document.querySelector('.profile-card');assert.ok(card);card.click();await t.settle();
 for(const n of ['1','2','3','4'])t.w.document.querySelector(`.lock-keys [data-k="${n}"]`).click();await t.settle();
 assert.ok(t.calls.some(c=>c.action==='login'&&c.pin==='1234'));
 assert.equal(t.w.document.getElementById('profile-avatar').textContent,'A');assert.deepEqual(t.errors,[]);
 }finally{t.dom.window.close();}
});
test('remembered authenticated reader boots without a new PIN prompt and saves via API',async()=>{
 const t=await app({remembered:true});try{assert.equal(t.w.document.getElementById('profile-avatar').textContent,'A');t.w.eval('setPref("theme","dark"); flushPrefs()');await t.settle();assert.ok(t.calls.some(c=>c.action==='patch'&&c.changes.theme==='dark'));assert.deepEqual(t.errors,[]);}finally{t.dom.window.close();}
});

test('boot scrubs legacy credentials from inactive reader caches while preserving preferences',async()=>{
 const t=await app();try{const cache=JSON.parse(t.w.localStorage.getItem('briefing_prefs_inactive'));assert.deepEqual(cache,{saved:['keep']});}finally{t.dom.window.close();}
});
