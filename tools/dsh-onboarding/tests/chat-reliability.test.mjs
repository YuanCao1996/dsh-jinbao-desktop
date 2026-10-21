import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createOverlayService} from '../overlay-state.mjs';
test('chat preserves full answers, rejects empty reply, exposes quota failure and permits retry after restart',async t=>{
 const stateDir=await mkdtemp(join(tmpdir(),'jinbao-chat-check-'));let answer='详尽回答'.repeat(1500),fail;
 const agentChat=async()=>{if(fail)throw Object.assign(Error('private provider details'),{status:fail});return answer;};
 let service=await createOverlayService({stateDir,agentChat,pollMs:100000});t.after(()=>service.close());
 assert.equal((await service.ask('请详细说明')).answer,answer);assert.ok(service.view().chat.includes(answer));
 answer='';await assert.rejects(service.ask('空回复'),e=>e.status===502);assert.match(service.view().chat,/有效回答/);
 fail=429;await assert.rejects(service.ask('额度失败'),e=>e.status===429);assert.match(service.view().chat,/额度不足/);assert.doesNotMatch(service.view().chat,/private provider/);
 fail=null;answer='恢复成功';assert.equal((await service.ask('重试')).answer,answer);
 await service.close();const saved=JSON.parse(await readFile(join(stateDir,'overlay-chat.json'),'utf8'));assert.ok(saved.chat.some(row=>row.text===answer));
 service=await createOverlayService({stateDir,agentChat,pollMs:100000});assert.match(service.view().chat,/请详细说明/);assert.equal((await service.ask('重启后')).answer,answer);
});
