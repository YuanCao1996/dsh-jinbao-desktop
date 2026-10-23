import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const html=readFileSync(new URL('../settings.html',import.meta.url),'utf8');
function render(status){
 const nodes=new Map(),el=id=>{if(!nodes.has(id))nodes.set(id,{classList:{toggle(){} }});return nodes.get(id);};
 const source=html.slice(html.indexOf('function renderUpdate(s)'),html.indexOf("el('checkUpdate').onclick"));
 runInNewContext(source+';renderUpdate(status);',{el,status,Date});return el;
}
test('installed notes survive acknowledged notice, failed checks and a newer download',()=>{
 for(const update of [{state:'checking'},{state:'failed'},{state:'ready',version:'1.2.4',notes:'Next release'}]){
  const el=render({version:'1.2.3',update,updateResult:{state:'success',version:'1.2.3',notes:'Fixed chat <script>',acknowledged:true}});
  assert.equal(el('installedReleaseNotes').textContent,'Fixed chat <script>');
  assert.equal(el('updateNotice').hidden,true);
 }
});
test('successful update shows its notes immediately',()=>{
 const el=render({version:'1.2.3',updateResult:{state:'success',version:'1.2.3',notes:'Fixed chat'}});
 assert.equal(el('updateNotice').hidden,false);assert.equal(el('updateNoticeNotes').textContent,'Fixed chat');
});
test('manual installs use bundled notes; rollback does not show failed-version notes',()=>{
 const el=render({version:'1.2.2',releaseNotes:'Installed version notes',updateResult:{state:'rollback',version:'1.2.3',notes:'Wrong notes'}});
 assert.equal(el('installedReleaseNotes').textContent,'Installed version notes');assert.equal(el('updateNoticeNotes').textContent,'');
});
