import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTailer } from '../lib/logstream.js';
test('skip historical backlog, read first new-file event and retain split UTF8 JSON lines',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'jinbao-tailer-')),old=join(dir,'old.jsonl'),empty=join(dir,'empty.jsonl');
 writeFileSync(old,'{"text":"历史"}\n');writeFileSync(empty,'');
 const seen=[],tailer=createTailer(dir,e=>seen.push(e),{pollMs:20,ingest:{classify:r=>r}});
 t.after(()=>tailer.stop());await sleep(50);assert.equal(seen.length,0);
 const fresh=join(dir,'new.jsonl');writeFileSync(fresh,'{"text":"新对局"}\n');await sleep(60);assert.equal(seen.at(-1).text,'新对局');
 appendFileSync(empty,'{"text":"原空文件"}\n');await sleep(60);assert.equal(seen.at(-1).text,'原空文件');
 const bytes=Buffer.from('{"text":"盖伦"}\n');appendFileSync(fresh,bytes.subarray(0,10));await sleep(60);assert.equal(seen.length,2);
 appendFileSync(fresh,bytes.subarray(10));await sleep(60);assert.equal(seen.at(-1).text,'盖伦');
 writeFileSync(fresh,'{"text":"截短"}\n');await sleep(60);assert.equal(seen.at(-1).text,'截短');
 tailer.pause();appendFileSync(fresh,'{"text":"暂停历史"}\n');tailer.resume();await sleep(60);assert.ok(!seen.some(e=>e.text==='暂停历史'));
});
