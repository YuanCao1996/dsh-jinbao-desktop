import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {runSpeechProcess} from '../speech-process.mjs';
const flush=()=>new Promise(r=>setImmediate(r));

test('abort does not release the audio slot before the owned process closes',async()=>{
 const controller=new AbortController(),child=new EventEmitter();child.stdin={on(){},end(){}};
 const promise=runSpeechProcess('fixture',{}, {signal:controller.signal,run:(_exe,_args,options,callback)=>{options.signal.addEventListener('abort',()=>callback(Object.assign(Error('aborted'),{code:'ABORT_ERR'}),''));return child;}});
 let settled=false;const checked=assert.rejects(promise,e=>e.code==='speech_cancelled').then(()=>settled=true);
 controller.abort();await flush();assert.equal(settled,false);
 child.emit('close',1);await checked;assert.equal(settled,true);
});

function silence(seconds){
 const bytes=Buffer.alloc(44+44100*seconds);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(22050,24);bytes.writeUInt32LE(44100,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);return{audioBase64:bytes.toString('base64')};
}
const script=fileURLToPath(new URL('../audio-player.ps1',import.meta.url));
test('native playback waits for a silent WAV and leaves no owned process',{skip:process.platform!=='win32'},async()=>{
 let pid;const started=Date.now();const result=await runSpeechProcess(script,silence(2),{signal:new AbortController().signal,onSpawn:value=>pid=value});
 assert.equal(JSON.parse(result).played,true);assert.ok(Date.now()-started>=1800);assert.ok(pid>0);assert.throws(()=>process.kill(pid,0));
});
test('cancelling native silent playback waits until the owned player exits',{skip:process.platform!=='win32'},async()=>{
 const controller=new AbortController();let pid;
 const playback=runSpeechProcess(script,silence(5),{signal:controller.signal,onSpawn:value=>pid=value});const checked=assert.rejects(playback,e=>e.code==='speech_cancelled');
 await new Promise(r=>setTimeout(r,1000));controller.abort();await checked;assert.ok(pid>0);assert.throws(()=>process.kill(pid,0));
});
