const test = require('node:test');
const assert = require('node:assert/strict');
const { consolidate } = require('../js/research-identities.js');
function pair() {
  const identities = {short:{name:'Example', type:'company'}, 'example-company':{name:'Example Company', type:'company'}};
  const review = {keys:['short','example-company'], decision:'same_entity', reviewedAt:'2026-09-11', evidence:'Same organization confirmed', identities};
  return [{slug:'short',name:'Example',type:'company',aliases:['EX'], profile:'Early profile',mentions:[{date:'2026-01-01',id:'s',title:'Original',valueUsd:10}],researchReviews:[review]}, {slug:'example-company',name:'Example Company',type:'company',profile:'Later profile',mentions:[{date:'2026-01-01',id:'s',title:'Resolved',valueUsd:12,referenceReview:{status:'resolved'}},{date:'2026-01-02',id:'t',valueUsd:20}],researchReviews:[structuredClone(review)]}];
}
test('reciprocal reviewed identities consolidate once and retain history', () => {
  const input=pair(); const before=structuredClone(input); const result=consolidate(input);
  assert.deepEqual(input,before);
  assert.equal(result.entries.length,1);
  const e=result.entries[0];assert.equal(e.slug,'example-company');
  assert.deepEqual(result.aliases,{'short':'example-company'});
  assert.deepEqual(e.identitySlugs,['example-company','short']);
  assert.equal(e.mentions.length,2);assert.equal(e.mentions.find(m=>m.id==='s').title,'Resolved');
  assert.deepEqual(e.stats,{mentions:2,firstSeen:'2026-01-01',lastSeen:'2026-01-02',dealVolumeUsd:32});
  assert.deepEqual(e.identityVariants.map(v=>v.profile),['Later profile','Early profile']);
  assert.ok(e.aliases.includes('Example'));assert.ok(e.aliases.includes('EX'));
});
test('single unilateral review is insufficient',()=>{const a=pair();delete a[1].researchReviews;assert.equal(consolidate(a).entries.length,2)});
test('distinct-related review never merges',()=>{const a=pair();for(const e of a)e.researchReviews[0].decision='distinct_related';assert.equal(consolidate(a).entries.length,2)});
test('missing group member never merges',()=>{const a=pair();assert.equal(consolidate([a[0]]).entries.length,1);assert.deepEqual(consolidate([a[0]]).aliases,{})});
test('identity snapshots required and changes invalidate reviews',()=>{
 for(const mutation of [a=>delete a[0].researchReviews[0].identities,a=>a[0].name='Different organization',a=>a[0].type='person']) {
  const a=pair();mutation(a);assert.equal(consolidate(a).entries.length,2);
 }
});
test('snapshots cannot authorize cross-type merges',()=>{const a=pair();a[0].type='person';for(const e of a)e.researchReviews[0].identities.short.type='person';assert.equal(consolidate(a).entries.length,2)});
test('terms merge without player type when matching snapshots',()=>{const a=pair();for(const e of a){e.term=e.name;delete e.name;delete e.type;for(const snap of Object.values(e.researchReviews[0].identities)){snap.term=snap.name;delete snap.name;delete snap.type}}assert.equal(consolidate(a).entries.length,1)});
test('canonical selection deterministic independent of input order',()=>{assert.deepEqual(consolidate(pair()).entries,consolidate(pair().reverse()).entries)});
test('repeated invocation preserves variants and stats',()=>{const a=consolidate(pair());const b=consolidate(a.entries);assert.deepEqual(b.entries,a.entries)});
test('overlapping inconsistent groups fail closed',()=>{const a=pair();const third={...structuredClone(a[1]),slug:'third'};const other={...structuredClone(a[0].researchReviews[0]),keys:['short','third'],identities:{short:{name:'Example',type:'company'},third:{name:'Example Company',type:'company'}}};a[0].researchReviews.push(other);third.researchReviews=[other];a.push(third);assert.equal(consolidate(a).entries.length,3)});
test('invalid data and unreviewed same names do not merge',()=>{assert.deepEqual(consolidate(null),{entries:[],aliases:{}});const a=pair();for(const e of a)delete e.researchReviews;assert.equal(consolidate(a).entries.length,2)});
test('conflicting distinct-related review vetoes consolidation',()=>{const a=pair();a[0].researchReviews.push({...a[0].researchReviews[0],decision:'distinct_related'});assert.equal(consolidate(a).entries.length,2)});
