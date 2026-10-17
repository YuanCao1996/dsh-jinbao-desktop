const clean=value=>typeof value==='string'?value.trim().slice(0,120):'';
export function progressSeconds(value,fallback=null){
  if(typeof value==='number'&&Number.isFinite(value)&&value>=0)return value;
  const m=typeof value==='string'&&/^(\d{1,3}):(\d{2})$/.exec(value);
  return m?Number(m[1])*60+Number(m[2]):fallback;
}
export function addProgressEvent(state,key,description,seconds,topic){
  if(state.events.some(e=>e.key===key))return;
  const time=Number.isFinite(seconds)&&seconds>=0?String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(Math.floor(seconds%60)).padStart(2,'0'):'时间未知';
  state.events.push({key,text:description,time,...(topic?{topic}:{})});state.events=state.events.slice(-40);
}
const heroes=state=>[state.me,...state.allies,...state.enemies].filter(p=>p?.champion);
const identity=value=>String(value??'').replace(/[\s·]/g,'').toLowerCase();
function namedHero(state,event){
  const name=clean(event.champion??event.championTitle);
  if(name)return name;
  const display=clean(event.display);
  return heroes(state).find(p=>display.includes(p.champion))?.champion??null;
}
function isOwn(state,event){
  if(event.who==='self'||event.side==='me')return true;
  if(['ally','enemy','other','unknown'].includes(event.who))return false;
  const names=[event.champion,event.championTitle].filter(Boolean).map(identity);
  return names.includes(identity(state.me.champion))&&!!state.me.champion;
}
export function projectProgressEvent(state,event){
  const seconds=progressSeconds(event.time??event.gameTime,state.gameSeconds);
  if(event.kind==='chat_events'){
    for(const message of Array.isArray(event.events)?event.events:[]){
      if(['purchase','augment_mutate','augment_picked','augment_picked_chat'].includes(message.kind))projectProgressEvent(state,{...message,gameTime:message.gameTime??seconds});
    }
  }
  if(event.kind==='purchase'){
    const hero=namedHero(state,event)??(isOwn(state,event)?state.me.champion:null),item=clean(event.item);
    addProgressEvent(state,JSON.stringify(['purchase',seconds,hero,item||event.itemId]),`${hero??'英雄未识别'}购买装备：${item||'装备名称未识别'}`,seconds,'equipment');
  }
  if(['augment_picked','augment_mutate','augment_picked_chat'].includes(event.kind)){
    const augment=clean(event.augment??event.name);if(!augment)return;
    const confirmed=event.confidence!=='low'&&event.source!=='ocr-inferred';
    const own=confirmed&&(isOwn(state,event)||(event.kind==='augment_picked'&&event.source==='scoreboard-icon'));
    const hero=namedHero(state,event),owner=own?'自己':hero??'归属未确认';
    addProgressEvent(state,JSON.stringify(['augment',event.kind,owner,augment,confirmed]),`${confirmed?'海克斯选择':'疑似海克斯选择'}：${owner} · ${augment}`,seconds,'augment-selection');
    if(own&&!state.ownedAugments.includes(augment))state.ownedAugments.push(augment);
  }
  if(event.kind==='augment_offer'){
    const names=state.offers.map(o=>clean(typeof o==='string'?o:o.name)).filter(Boolean);
    if(names.length)addProgressEvent(state,JSON.stringify(['offers',event.roll,names]),`${event.reroll?'海克斯刷新':'海克斯三选一'}：${names.join('、')}`,seconds);
  }
  if(event.kind==='augment_offer_closed')addProgressEvent(state,'offer-closed:'+event.roll,'海克斯面板关闭，等待确认选择结果',seconds);
}
export function observeEquipment(state){
  const seen=new Set();
  for(const player of heroes(state)){
    const key=player.championAlias||player.champion;if(seen.has(key))continue;seen.add(key);
    const current=new Map();
    for(const item of Array.isArray(player.items)?player.items:[]){
      const name=clean(typeof item==='string'?item:item?.name);if(!name)continue;
      const id=String(item?.id??name),count=Number.isFinite(item?.count)&&item.count>0?item.count:1;
      const old=current.get(id);current.set(id,{name,count:count+(old?.count??0)});
    }
    const previous=state.equipmentSnapshots.get(key);state.equipmentSnapshots.set(key,current);
    if(!previous)continue; // First observation is a baseline, never a fabricated purchase.
    const added=[],removed=[];
    for(const [id,item] of current){const n=item.count-(previous.get(id)?.count??0);if(n>0)added.push(item.name+(n>1?' ×'+n:''));}
    for(const [id,item] of previous){const n=item.count-(current.get(id)?.count??0);if(n>0)removed.push(item.name+(n>1?' ×'+n:''));}
    if(added.length||removed.length)addProgressEvent(state,JSON.stringify(['inventory',key,state.at,added,removed]),`装备更新：${player.champion}`+(added.length?' · 新增 '+added.join('、'):'')+(removed.length?' · 移除 '+removed.join('、'):''),state.gameSeconds,'equipment');
  }
}
