const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
const app=fs.readFileSync(require('node:path').join(__dirname,'../js/app.js'),'utf8');
function section(start,end){return app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));}
function context(extra={}){const dom=new JSDOM('<!doctype html>',{url:'https://briefing.test/'});return vm.createContext({document:dom.window.document,URL,Set,Map,Date,JSON,Promise,localStorage:dom.window.localStorage,...extra});}
test('article sanitizer removes event handlers, active elements and unsafe URLs while retaining article formatting',()=>{
 const c=context({isJunkImageUrl:()=>false});vm.runInContext(section('function sanitizeArticleHtml(', '/* Identify the same underlying photo'),c);
 const out=c.sanitizeArticleHtml('<p>Hello <strong>world</strong></p><img src="https://news.test/photo.jpg" onerror="alert(1)"><svg onload="alert(1)"></svg><iframe src="https://bad.test"></iframe><a href="javascript:alert(1)">bad</a>');
 const d=new JSDOM(out).window.document;
 assert.equal(d.querySelector('[onerror],[onload],svg,iframe,[href^="javascript:"]'),null);
 assert.equal(d.querySelector('strong').textContent,'world');assert.equal(d.querySelector('img').getAttribute('src'),'https://news.test/photo.jpg');
});
test('an obsolete article request cannot redirect a newer navigation',async()=>{
 let resolve;const c=context({getDay:()=>new Promise(r=>resolve=r),location:{hash:'#/story/2026-09-06/old'}});
 vm.runInContext(section('async function openReaderRoute(', '\nfunction hideReader('),c);
 const p=c.openReaderRoute('2026-09-06','old');c.location.hash='#/map';resolve(null);await p;assert.equal(c.location.hash,'#/map');
});
test('offline saved dates reflect successful downloads rather than a prefix',async()=>{
 const state={dates:['2026-09-05','2026-09-06'],days:new Map()};
 const c=context({state,navigator:{onLine:true},sb:async q=>{if(q.includes('2026-09-06'))throw Error('offline');return [{data:{date:'2026-09-05'}}]},location:{hash:'#/'},flashToast(){},route(){},sanitizeDayUrls:x=>x});
 vm.runInContext(section('const OFFLINE_DAYS =','/* online/offline UX'),c);await c.preloadForOffline(true);assert.deepEqual(Array.from(state.offlineReady.dates),['2026-09-05']);
});
test('saving reader A never reads reader B fields after a network wait',async()=>{
 const {createProfileStore}=require('../js/profile-store.js');
 let resolve;const writes=[];
 const profile={slug:'a',name:'Alice',color:'red',guest:false,dirty:new Set(['saved']),data:{saved:['a-story']}};
 const c=context({profile});
 c.prefStore=createProfileStore(c.localStorage,async(slug,changes)=>{await new Promise(r=>resolve=r);writes.push({slug,changes});return changes});
 c.prefStore.enqueue('a','saved',['a-story']);
 vm.runInContext(section('async function flushPrefs()', 'function paintAvatar()'),c);
 const p=c.flushPrefs();Object.assign(profile,{slug:'b',name:'Bob',data:{saved:['b-story']},dirty:new Set()});resolve();await p;
 assert.deepEqual(writes,[{slug:'a',changes:{saved:['a-story']}}]);assert.deepEqual(profile.data.saved,['b-story']);
});
test('subscription already owned by another reader is replaced, never transferred by endpoint alone',async()=>{
 let unsubscribed=false;const writes=[];const old={unsubscribe:async()=>{unsubscribed=true;return true}};
 const c=context({profile:{slug:'b'},readerApi:async(action,slug,payload)=>{writes.push({slug,payload});if(writes.length===1){const e=Error('endpoint_owned');e.status=409;throw e}},currentPushSub:async()=>old,vapidPublicKey:async()=> 'test',urlB64ToUint8Array:()=>new Uint8Array(),navigator:{serviceWorker:{ready:Promise.resolve({pushManager:{subscribe:async()=>({toJSON:()=>({endpoint:'https://push.test/new'})})}})}}});
 vm.runInContext(section('async function savePushSub(', 'async function enableAlerts()'),c);
 await c.savePushSub({endpoint:'https://push.test/old'},false);
 assert.equal(unsubscribed,true);assert.equal(writes.at(-1).slug,'b');assert.equal(writes.at(-1).payload.sub.endpoint,'https://push.test/new');
});
test('same VAPID key still verifies current reader ownership',async()=>{
 let registered=false;const c=context({profile:{slug:'b',guest:false},pushSupported:()=>true,currentPushSub:async()=>({toJSON:()=>({endpoint:'old'})}),vapidPublicKey:async()=> 'same',subServerKeyB64:()=> 'same',savePushSub:async()=>{registered=true}});
 vm.runInContext(section('async function reconcilePushSub()', 'async function savePushSub('),c);await c.reconcilePushSub();assert.equal(registered,true);
});
test('profile switch proceeds when durable pending changes cannot yet sync',async()=>{
 let reloads=0;const profile={slug:'a'};const c=context({profile,coldBoot:false,clearLocked(){},activateProfile:async slug=>{profile.slug=slug},flushPrefs:async()=>{throw Error('offline')},location:{reload(){reloads++}},closePicker(){throw Error('must not reveal old profile page')}});
 vm.runInContext(section('  const proceed = async (p)', '  const backLink =')+'\nglobalThis.proceed=proceed;',c);
 await c.proceed({slug:'b'});assert.equal(reloads,1);
});

test('market labels remain text even when stored content contains HTML',()=>{
 const c=context();vm.runInContext(section('function marketBackdropLink(', 'function compMarketRow('),c);
 const value='<img src=x onerror="alert(1)">';const link=c.marketBackdropLink(value);
 assert.equal(link.querySelector('img,[onerror]'),null);assert.ok(link.textContent.includes(value));
});
