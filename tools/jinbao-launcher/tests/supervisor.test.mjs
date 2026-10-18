import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSupervisor, parseDevices } from '../supervisor.mjs';
import { settingsAddress } from '../main.mjs';

test('automatic collectors handle unauthorized phones, hot swaps, duplicate ticks and owned cleanup', async () => {
  let devices = 'List of devices attached\nphone-A\tunauthorized\n';
  const children = [];
  const calls = [];
  const supervisor = createSupervisor({ root: 'D:/package', stateDir: 'D:/state',getPhoneEnabled:async()=>true,
    adbController:{env:()=>({ADB_SERVER_SOCKET:'tcp:127.0.0.1:55555'}),close:async()=>{},
    run: async (args) => {
      calls.push(args);
      return { stdout: args[0] === 'devices' ? devices : '1234\n' };
    },
    },
    spawnImpl: (exe, args, opts) => {
      const child = new EventEmitter();
      child.killed = false;
      child.kill = () => { child.killed = true; child.emit('exit', 0); };
      children.push({ child, args, opts });
      return child;
    },
  });
  assert.equal((await supervisor.tick()).status, 'unauthorized');
  assert.equal(children.length, 1);
  devices = 'List of devices attached\nphone-A\tdevice\n';
  await supervisor.tick(); await supervisor.tick();
  assert.equal(children.length, 2);
  assert.equal(children[1].opts.env.JINBAO_ADB_SERIAL, 'phone-A');
  assert.equal(children[1].opts.windowsHide, true);
  assert.deepEqual(calls.find(args => args.includes('pidof')), ['-s', 'phone-A', 'shell', 'pidof', 'com.example.jinbao']);
  devices = 'List of devices attached\nphone-B\tdevice\n';
  await supervisor.tick();
  assert.equal(children[1].child.killed, true);
  devices += 'phone-C\tdevice\n';
  assert.equal((await supervisor.tick()).status, 'multiple-devices');
  supervisor.close();
  assert.equal(children[0].child.killed, true);
  const count = children.length;
  await supervisor.tick();
  assert.equal(children.length, count);
});

test('only a nonce-bearing loopback setup link is opened', () => {
  const nonce = 'a'.repeat(64);
  assert.deepEqual(settingsAddress('http://127.0.0.1:3084/#' + nonce), { origin: 'http://127.0.0.1:3084', nonce });
  for (const address of ['https://evil.test/#' + nonce, 'http://127.0.0.1:3084/?redirect=evil#' + nonce,
    'http://user:pass@127.0.0.1:3084/#' + nonce]) assert.throws(() => settingsAddress(address));
  assert.deepEqual(parseDevices('List of devices attached\na\tdevice\nb\toffline\n'), [
    { serial: 'a', status: 'device' }, { serial: 'b', status: 'offline' },
  ]);
});

test('computer-only default never starts or queries ADB; explicit disable cleans owned phone service',async()=>{
 let enabled=false,queries=0,closes=0;const children=[];
 const supervisor=createSupervisor({root:'D:/package',stateDir:'D:/state',getPhoneEnabled:async()=>enabled,
 adbController:{env:()=>({ADB_SERVER_SOCKET:'tcp:127.0.0.1:55555'}),run:async()=>{queries++;return {stdout:'List of devices attached\n'};},close:async()=>{closes++;}},
 spawnImpl:()=>{const child=new EventEmitter();child.kill=()=>child.emit('exit',0);children.push(child);return child;}});
 await supervisor.tick();await supervisor.tick();assert.equal(queries,0);assert.equal(children.length,1);
 enabled=true;await supervisor.tick();assert.equal(queries,1);enabled=false;const before=closes;await supervisor.tick();assert.equal(closes,before+1);assert.equal(queries,1);
 await supervisor.close();await supervisor.tick();assert.equal(queries,1);
});
