import test from 'node:test';
import assert from 'node:assert/strict';
import { briefingCopy } from '../supabase/functions/_shared/backend-policy.mjs';
test('ready notification uses complete ranked microcopy without clipping',()=>{
 assert.deepEqual(briefingCopy({stories:[{quickSummary:'Extell closes $1.25B financing.'},{quickSummary:'NYC weighs $92.2M tax benefit.'}]}),{title:"Today's briefing",body:'Extell closes $1.25B financing. • NYC weighs $92.2M tax benefit.'});
});
test('does not truncate long or unreviewed prose',()=>{
 assert.equal(briefingCopy({stories:[{quickSummary:'A'.repeat(140),title:'A'.repeat(150)},{quickSummary:'A complete short update.'}]}).body,'A complete short update.');
});
test('empty edition has truthful fallback and HTML cannot leak into payload',()=>{
 assert.equal(briefingCopy({stories:[]}).body,'Your latest edition is available.');
 assert.equal(briefingCopy({stories:[{quickSummary:'<b>New loan closes.</b>'}]}).body,'New loan closes.');
});
