import test from 'node:test';import assert from 'node:assert/strict';
import {teamStrength} from '../team-strength.mjs';
test('tier weights affect mixed-strength team samples, preserve bounds and exclude bench',()=>{
 const rows=[{side:'友',winRate:60,tierText:'T0'},...Array.from({length:4},()=>({side:'友',winRate:40,tierText:'T4'})),{side:'备选',winRate:100,tierText:'T0'}];
 const value=teamStrength(rows,'友').value;assert.ok(Math.abs(value-45.4545454545)<1e-8);assert.notEqual(value,44);
 assert.equal(teamStrength(rows.map(r=>({...r,winRate:100})),'友').value,100);
 assert.equal(teamStrength(rows.map(r=>({...r,winRate:0})),'友').value,0);
 assert.equal(teamStrength(rows.map((r,i)=>i===0?{...r,tierText:'暂无'}:r),'友').value,null);
 assert.equal(teamStrength(rows.map((r,i)=>i===0?{...r,winRate:null}:r),'友').known,4);
 assert.equal(teamStrength(rows.slice(1),'友').value,null);
});
