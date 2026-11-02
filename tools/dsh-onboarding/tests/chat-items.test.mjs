import test from 'node:test';
import assert from 'node:assert/strict';
import {parseChat} from '../../lol-companion/chat.mjs';

const ITEMS=[{name:'残疫',id:3118},{name:'卢登的激荡',id:6655},{name:'长剑',id:1036}];
const itemMap=new Map(ITEMS.map(i=>[i.name,i]));
const opts={
  width:1200,height:600,
  championsInText:()=>[],
  isChampion:()=>false,
  championFix:()=>null,
  augmentLookup:()=>null,
  augmentsInText:()=>[],
  itemLookup:value=>{
    if(value.startsWith('~prefix~')){
      const prefix=value.slice(8);
      const hit=ITEMS.filter(i=>i.name.startsWith(prefix));
      return hit.length===1?hit[0].name:null;
    }
    if(value.startsWith('~fix~'))return null;
    const hit=itemMap.get(value);
    return hit?{name:hit.name,id:hit.id}:null;
  },
};

const line=(text,i)=>({text,box:[10,600+i*20,700,18]});
const buy=text=>parseChat([line(text,0)],opts).find(m=>m.kind==='purchase');

test('an item name that OCR split with spaces still resolves',()=>{
  const m=buy('某人（锐雯）购买了残 疫');
  assert.ok(m,'purchase line must parse');
  assert.equal(m.item,'残疫');
  assert.equal(m.itemUnresolved,false);
  assert.equal(m.itemId,3118);
});

test('a trailing item id next to the name is still trimmed',()=>{
  const m=buy('某人（锐雯）购买了残疫 3118');
  assert.equal(m.item,'残疫');
});

test('a four character item name split into two pairs resolves',()=>{
  const m=buy('某人（锐雯）购买了卢登的 激荡');
  assert.equal(m.item,'卢登的激荡');
});

test('an unknown item keeps its raw text instead of pretending to resolve',()=>{
  const m=buy('某人（锐雯）购买了神秘护符');
  assert.equal(m.item,null);
  assert.equal(m.itemUnresolved,true);
  assert.equal(m.itemRaw,'神秘护符');
});
