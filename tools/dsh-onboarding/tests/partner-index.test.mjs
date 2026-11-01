import test from 'node:test';
import assert from 'node:assert/strict';
import {initialOverlayState,applyOverlayEvent,overlayView} from '../overlay-state.mjs';
import {partnerIndex,resolveChampionId,bestPartners,champSelectPartnerText,partnerStatDate} from '../../lol-companion/partner-index.mjs';

test('the bundled partner dataset covers the collected champions and records its date',()=>{
  const index=partnerIndex();
  assert.ok(index.partners&&Object.keys(index.partners).length>100,'index should cover the collected roster');
  assert.equal(partnerStatDate(),'2026-10-31');
  assert.ok(index.note.includes('配合胜率'));
});

test('champion names resolve from 称号, 英雄名, English alias and raw id alike',()=>{
  const id=resolveChampionId('疾风剑豪');
  assert.ok(Number.isInteger(id)&&id>0);
  assert.equal(resolveChampionId('亚索'),id,'英雄名 must resolve to the same champion');
  assert.equal(resolveChampionId('Yasuo'),id,'English alias must resolve too');
  assert.equal(resolveChampionId(id),id);
  assert.equal(resolveChampionId('根本不存在的英雄'),null);
});

test('best partners are the highest synergy pairs and stay bounded',()=>{
  const rows=bestPartners('疾风剑豪',{limit:3});
  assert.equal(rows.length,3);
  assert.equal(rows[0].name,'卡牌大师','疾风剑豪 pairs best with 卡牌大师 in the collected data');
  assert.ok(rows[0].winRate>66&&rows[0].winRate<67);
  assert.ok(rows[0].winRate>=rows[1].winRate&&rows[1].winRate>=rows[2].winRate,'sorted by synergy win rate');
  assert.equal(bestPartners('根本不存在的英雄').length,0);
});

test('the champion-select block lists picked champions and marks partners already on the team',()=>{
  const text=champSelectPartnerText(['疾风剑豪','卡牌大师']);
  assert.match(text,/^最佳拍档 · 选人/);
  assert.match(text,/疾风剑豪：/);
  assert.match(text,/卡牌大师：/);
  assert.match(text,/✓/,'already-picked partners must be marked');
  assert.match(text,/已在队内/);
  // No duplicate champion lines.
  const lines=text.split('\n').slice(1);
  assert.equal(new Set(lines.map(line=>line.split('：')[0])).size,lines.length);
});

test('an empty or unknown selection renders nothing rather than an empty header',()=>{
  assert.equal(champSelectPartnerText([]),'');
  assert.equal(champSelectPartnerText(['根本不存在的英雄']),'');
  assert.equal(champSelectPartnerText(null),'');
});

test('the overlay shows partners on the 战况 page only while champion select is active',()=>{
  const state=initialOverlayState();
  let at=1000;
  const emit=event=>applyOverlayEvent(state,{game:'lol',match:'m1',t:++at,...event},'m1');
  emit({kind:'champ_select',me:{championId:157,champion:'疾风剑豪'},
    allies:[{championId:157,champion:'疾风剑豪'},{championId:4,champion:'卡牌大师'}],
    enemies:[],bench:[]});
  assert.equal(state.phase,'ChampSelect');
  const advice=overlayView(state).advice;
  assert.match(advice,/最佳拍档 · 选人/);
  assert.match(advice,/疾风剑豪：卡牌大师/);

  // Leaving champion select drops the block from the page.
  emit({kind:'game_start',me:{champion:'疾风剑豪'}});
  assert.doesNotMatch(overlayView(state).advice,/最佳拍档 · 选人/);
});
