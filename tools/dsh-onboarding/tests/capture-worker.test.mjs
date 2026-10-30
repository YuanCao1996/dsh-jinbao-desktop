import test from 'node:test';import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';import {PassThrough,Writable} from 'node:stream';
import {createAugmentCaptureWorker} from '../../lol-companion/capture-worker.mjs';
function processFixture(answer){
 const child=new EventEmitter();child.stdout=new PassThrough();child.killed=false;
 child.stdin=new Writable({write(_chunk,_encoding,done){answer(child);done();}});
 child.kill=()=>{child.killed=true;child.emit('exit',0);};return child;
}
test('OCR worker reuses one process and cleans up only its own child',async()=>{
 let starts=0;const owned=[];
 const worker=createAugmentCaptureWorker({spawnImpl:()=>{starts++;const child=processFixture(c=>c.stdout.write(JSON.stringify({available:true,titleLines:[{text:'仆从大师'}]})+'\n'));owned.push(child);return child;}});
 assert.equal((await worker.capture()).available,true);assert.equal((await worker.capture()).titleLines[0].text,'仆从大师');
 assert.equal(starts,1);worker.close();assert.equal(owned[0].killed,true);await assert.rejects(worker.capture());
});
test('OCR timeout restarts worker; aborted capture releases its process',async()=>{
 let starts=0;const children=[];
 const worker=createAugmentCaptureWorker({timeoutMs:20,spawnImpl:()=>{const index=starts++;const child=processFixture(c=>{if(index===1)c.stdout.write('{"available":true}\n');});children.push(child);return child;}});
 await assert.rejects(worker.capture(),/timeout/);assert.equal(children[0].killed,true);
 assert.equal((await worker.capture()).available,true);assert.equal(starts,2);worker.close();
 const controller=new AbortController(),child=processFixture(()=>{});
 const abortable=createAugmentCaptureWorker({spawnImpl:()=>child});const pending=abortable.capture(controller.signal);controller.abort();
 await assert.rejects(pending,/stopped/);assert.equal(child.killed,true);abortable.close();
});

test('title focus is a bounded command and invalid focus never starts a child',async()=>{
 const commands=[];let starts=0;
 const worker=createAugmentCaptureWorker({spawnImpl:()=>{starts++;const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>{};child.stdin=new Writable({write(chunk,_encoding,done){commands.push(chunk.toString());child.stdout.write('{"available":true}\n');done();}});return child;}});
 await assert.rejects(worker.capture(undefined,{focus:'invalid'}));assert.equal(starts,0);
 await worker.capture(undefined,{focus:'titles'});await worker.capture();assert.deepEqual(commands,['capture:titles\n','capture\n']);worker.close();
});
