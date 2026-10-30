import test from 'node:test';
import assert from 'node:assert/strict';
import {createCaptureSchedule} from '../../lol-companion/capture-schedule.mjs';
test('selection gets fast title frames while full HUD/chat scans continue periodically',()=>{
 let clock=0;const schedule=createCaptureSchedule({now:()=>clock});
 assert.equal(schedule.choose(0),'full');clock=500;assert.equal(schedule.choose(3),'titles');clock=1000;assert.equal(schedule.choose(3),'titles');
 clock=2000;assert.equal(schedule.choose(3),'full');clock=2500;assert.equal(schedule.choose(0),'full');
 schedule.reset();clock=2600;assert.equal(schedule.choose(3),'full');
});
