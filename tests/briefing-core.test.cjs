const {test}=require('node:test');const assert=require('node:assert/strict');
const {formatPeriod,safeHttpUrl,qualifyingSale,compGroups}=require('../js/briefing-core.js');
test('partial periods are formatted without inventing day precision',()=>{
 assert.equal(formatPeriod('2026-Q2'),'Q2 2026');assert.equal(formatPeriod('2026-09'),'September 2026');
 assert.equal(formatPeriod(null),'Date unavailable');assert.equal(formatPeriod('2026-02-31'),'Date unavailable');
 assert.equal(formatPeriod('2026-09-11',{month:'short',day:'numeric'}),'Sep 11');
});
test('external links reject executable, invalid and credential URLs',()=>{
 assert.equal(safeHttpUrl('javascript:alert(1)'),null);assert.equal(safeHttpUrl('https://user:pass@example.com'),null);
 assert.equal(safeHttpUrl('https://example.com/story'),'https://example.com/story');
});
test('comparisons exclude loans, plans and unverified legacy price meanings',()=>{
 const s={dealType:'Sale',valueUsd:12000000,assetClass:'Office',market:'New York',transactionStatus:'closed',valueType:'salePrice',sizeSqft:30000};
 assert(qualifyingSale(s));assert(!qualifyingSale({...s,dealType:'Financing'}));assert(!qualifyingSale({...s,transactionStatus:'listed'}));
 assert(!qualifyingSale({...s,valueType:undefined,transactionStatus:undefined}));
});
test('comparison medians never mix asset classes and repeated transaction IDs dedupe',()=>{
 const base={dealType:'Sale',valueType:'salePrice',transactionStatus:'closed',valueUsd:1e7,market:'New York',assetClass:'Office',_date:'2026-09-11'};
 const groups=compGroups([{...base,transactionId:'a'},{...base,transactionId:'a'},{...base,transactionId:'b',assetClass:'Hotel'}]);
 assert.equal(groups.length,2);assert(groups.every(g=>g.deals.length===1));
});
