import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdaptiveScheduler } from '../adaptive.mjs';

test('regions rotate fairly and unread feedback increases quality then abandons stale detail plan',()=>{
 let time=0;const s=createAdaptiveScheduler({now:()=>time});
 const regions=[{x:0,y:0,width:.2,height:.2},{x:.5,y:.5,width:.2,height:.2}];
 s.propose({regions,quality:'overview'});
 assert.deepEqual(s.admit({active:true}).request.roi,regions[0]);time=2000;
 assert.deepEqual(s.admit({active:true}).request.roi,regions[1]);
 s.feedback({readable:false});assert.equal(s.status().plan.quality,'standard');
 s.feedback({readable:false});assert.equal(s.status().plan.quality,'detail');
 s.feedback({readable:false});assert.equal(s.status().plan,null);
});

test('local plans periodically patrol overview without losing ROI or resetting patrol on renewal',()=>{
 let time=0;const s=createAdaptiveScheduler({now:()=>time});
 const plan={roi:{x:0.2,y:0.2,width:0.3,height:0.3},task:'text',duration_ms:30000};
 s.propose(plan);let r=s.admit({active:true});assert.equal(r.request.quality,'detail');assert.deepEqual(r.request.roi,plan.roi);
 time=10000;s.propose(plan);
 time=15000;r=s.admit({active:true});assert.equal(r.reason,'overview_patrol');assert.equal(r.request.quality,'overview');assert.equal(r.request.roi,undefined);
 time=17000;r=s.admit({active:true});assert.deepEqual(r.request.roi,plan.roi);
 time=31000;r=s.admit({active:true,manual:true});assert.deepEqual(r.request.roi,plan.roi);
});

test('patrol respects budget and background; task defaults never override explicit quality',()=>{
 let time=0;const s=createAdaptiveScheduler({now:()=>time,maxCapturesPerMinute:1});
 s.propose({task:'text',quality:'standard',roi:{x:0,y:0,width:0.5,height:0.5}});
 assert.equal(s.admit({active:true}).request.quality,'standard');time=16000;
 assert.equal(s.admit({active:false}).reason,'target_not_active');
 assert.equal(s.admit({active:true}).reason,'capture_budget_exhausted');
 assert.throws(()=>s.propose({task:'arbitrary'}),/invalid_observation_task/);
});

test('failed capture recovers with bounded overview probes without manual intervention',()=>{
 let time=0;const s=createAdaptiveScheduler({now:()=>time});
 s.propose({quality:'detail',duration_ms:30000});
 for(let i=0;i<3;i++){assert.equal(s.admit({active:true}).allowed,true);s.complete({ok:false});time+=5000;}
 assert.equal(s.admit({active:true}).allowed,false);
 time=25000;assert.equal(s.admit({active:false}).allowed,false);
 const probe=s.admit({active:true});assert.equal(probe.allowed,true);assert.equal(probe.request.quality,'overview');
 s.complete({ok:true,changed:false});assert.equal(s.status().paused,false);
});

test('stable board slows down and changes temporarily accelerate without spending model calls', () => {
  let time = 0;
  const scheduler = createAdaptiveScheduler({ now: () => time });
  assert.equal(scheduler.admit({ active: true }).allowed, true);
  scheduler.complete({ changed: false, ok: true });
  time = 2000;
  assert.equal(scheduler.admit({ active: true }).allowed, true);
  scheduler.complete({ changed: false, ok: true });
  time = 4000;
  assert.equal(scheduler.admit({ active: true }).reason, 'observation_cooldown');
  time = 8000;
  assert.equal(scheduler.admit({ active: true }).allowed, true);
  scheduler.complete({ changed: true, ok: true });
  time = 9000;
  assert.equal(scheduler.admit({ active: true }).allowed, true);
});

test('agent plan has TTL, cannot lower hard interval and never overrides capture budget', () => {
  let time = 0;
  const scheduler = createAdaptiveScheduler({ now: () => time, maxCapturesPerMinute: 2 });
  scheduler.propose({ quality: 'detail', interval_ms: 1000, duration_ms: 2000 });
  assert.equal(scheduler.admit({ active: true }).request.quality, 'detail');
  time = 500;
  assert.equal(scheduler.admit({ active: true, manual: true }).reason, 'observation_cooldown');
  time = 2000;
  assert.equal(scheduler.admit({ active: true, manual: true }).request.quality, 'overview');
  time = 10000;
  assert.equal(scheduler.admit({ active: true, manual: true }).reason, 'capture_budget_exhausted');
  time = 61000;
  assert.equal(scheduler.admit({ active: true, manual: true }).allowed, true);
});

test('background and repeated failures pause automatic work, manual retry remains bounded', () => {
  let time = 0;
  const scheduler = createAdaptiveScheduler({ now: () => time });
  assert.equal(scheduler.admit({ active: false }).reason, 'target_not_active');
  for (let i = 0; i < 3; i++) {
    assert.equal(scheduler.admit({ active: true }).allowed, true);
    scheduler.complete({ ok: false });
    time += 5000;
  }
  assert.equal(scheduler.admit({ active: true }).reason, 'observation_paused');
  assert.equal(scheduler.admit({ active: true, manual: true }).allowed, true);
  scheduler.complete({ changed: false, ok: true });
  assert.equal(scheduler.status().paused, false);
});

test('malicious plans cannot change window, path or GPU load limits', () => {
  const scheduler = createAdaptiveScheduler();
  for (const plan of [{ target_id: 'lol' }, { path: 'C:/secret' }, { interval_ms: 10 },
    { duration_ms: 60000 }, { quality: 'unlimited' }, { roi: { x: -1, y: 0, width: 1, height: 1 } }]) {
    assert.throws(() => scheduler.propose(plan));
  }
  assert.equal(scheduler.status().captures_in_last_minute, 0);
});
