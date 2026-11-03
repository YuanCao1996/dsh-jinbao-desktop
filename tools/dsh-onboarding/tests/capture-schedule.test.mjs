import test from 'node:test';
import assert from 'node:assert/strict';
import {createCaptureSchedule} from '../../lol-companion/capture-schedule.mjs';
test('selection gets fast title frames while full HUD/chat scans continue periodically',()=>{
 let clock=0;const schedule=createCaptureSchedule({now:()=>clock});
 assert.equal(schedule.choose(0),'full');clock=500;assert.equal(schedule.choose(3),'titles');clock=1000;assert.equal(schedule.choose(3),'titles');
 clock=2000;assert.equal(schedule.choose(3),'full');
 // No panel on screen is the normal case: a full scan per cycle was pure waste, so it now
 // waits for the same interval and the cheap title pass covers the gap.
 clock=2500;assert.equal(schedule.choose(0),'titles');clock=4000;assert.equal(schedule.choose(0),'full');
 schedule.reset();clock=4100;assert.equal(schedule.choose(3),'full');
});
