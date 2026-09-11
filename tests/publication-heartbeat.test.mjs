import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readPrimaryHeartbeat} from '../supabase/functions/_shared/fill-heartbeat.mjs';
test('primary worker row takes precedence over legacy standby pulse',async()=>{const result=await readPrimaryHeartbeat(async path=>path.startsWith('publication_workers')?[{data:{state:'running',via:'github-actions'}}]:[{data:{via:'supabase-edge'}}]);assert.equal(result.via,'github-actions');});
test('failed primary cannot be hidden by a fresh legacy standby pulse',async()=>{const result=await readPrimaryHeartbeat(async path=>path.startsWith('publication_workers')?[{data:{state:'failed',lastRun:'2026-09-11T01:00:00Z'}}]:[{data:{lastRun:'2026-09-11T02:00:00Z'}}]);assert.equal(result,null);});
test('legacy heartbeat remains readable before first upgraded primary run',async()=>{const result=await readPrimaryHeartbeat(async path=>path.startsWith('publication_workers')?[]:[{data:{via:'github-actions'}}]);assert.equal(result.via,'github-actions');});
