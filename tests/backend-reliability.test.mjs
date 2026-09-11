import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCapture, captureAuthorized } from '../supabase/functions/_shared/session-capture.mjs';
import { pushCopy, discoveryDates, mergeMarket, isPushEligible } from '../supabase/functions/_shared/backend-policy.mjs';
test('capture requires private authority or atomic scoped ticket; public key is not authority',async()=>{
 const req=new Request('https://example.com',{headers:{apikey:'public'}});
 assert.equal(await captureAuthorized(req,'private',{},async()=>true),false);
 assert.equal(await captureAuthorized(req,'private',{captureToken:'a'.repeat(64)},async()=>false),false);
 assert.equal(await captureAuthorized(req,'private',{captureToken:'a'.repeat(64)},async()=>true),true);
 assert.equal(await captureAuthorized(new Request('https://example.com',{headers:{'x-audit-secret':'private'}}),'private',{},async()=>false),true);
});
test('capture only supports publishers and bounded cookie headers',()=>{
 assert.equal(validateCapture({domain:'www.therealdeal.com',cookie:'session='+'x'.repeat(30)}).domain,'therealdeal.com');
 for(const domain of ['evil.com','therealdeal.com.evil.com','com','foo.bisnow.com']) assert.throws(()=>validateCapture({domain,cookie:'a='.repeat(20)}));
 for(const cookie of ['a=x','a='+ 'x'.repeat(33000),'a=x\r\nfoo: bar']) assert.throws(()=>validateCapture({domain:'bisnow.com',cookie}));
});
test('push copy stays bounded and does not clip into misleading fragments',()=>{
 assert.deepEqual(pushCopy('x'.repeat(300),'y'.repeat(400)),{title:'CRE Briefing update',body:'Open the briefing for the full story.'});
 assert.deepEqual(pushCopy('Sale closes','A buyer acquired the office.'),{title:'Sale closes',body:'A buyer acquired the office.'});
});
test('discovery only includes yesterday and today across year boundaries',()=>{
 assert.deepEqual(discoveryDates('2027-01-01'),['2026-12-31','2027-01-01']);
});
test('market merge retains failed series and flags retained source without clobbering new data',()=>{
 const old={national:{a:{latest:{date:'2026-01-01',value:1}},b:{latest:{date:'2026-01-01',value:2}}},metros:{NY:{rent:{latest:{date:'2026-01-01',value:10}}}}};
 const fresh={national:{a:{latest:{date:'2026-02-01',value:3}}},metros:{NY:{}}};
 const result=mergeMarket(old,fresh);
 assert.equal(result.national.a.latest.value,3);assert.equal(result.national.b.latest.value,2);assert.equal(result.national.b.stale,true);assert.equal(result.metros.NY.rent.latest.value,10);
 assert.equal(old.national.b.stale,undefined);
});

test('urgency is an editorial decision independent of newsletter cadence',()=>{
 assert.equal(isPushEligible({cadence:'special'}),false);
 assert.equal(isPushEligible({cadence:'daily',pushEligible:true}),true);
 assert.equal(isPushEligible({cadence:'special',featured:true,pushEligible:false}),false);
 assert.equal(isPushEligible({cadence:'special',featured:true}),true);
 assert.equal(isPushEligible({cadence:'special',featured:true,brief:true}),false);
});
