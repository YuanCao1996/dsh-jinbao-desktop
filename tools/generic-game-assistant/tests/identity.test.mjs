import test from 'node:test';
import assert from 'node:assert/strict';
import {createIdentityTracker} from '../identity.mjs';
test('identity requires independent frames, expires, and clears mode after game switch',()=>{
 let time=0;const t=createIdentityTracker({now:()=>time});
 const field=value=>({value,confidence:'high',evidence:['visible title']});
 t.observe({game_name:field('A'),game_mode:field('mode A')},'frame1');
 t.observe({game_name:field('A')},'frame1');assert.equal(t.snapshot().game_name.status,'tentative');
 t.observe({game_name:field('A')},'frame2');assert.equal(t.snapshot().game_name.status,'corroborated');
 t.observe({game_name:field('B')},'frame3');assert.equal(t.snapshot().game_mode,undefined);
 time=60001;assert.deepEqual(t.snapshot(),{});
});
