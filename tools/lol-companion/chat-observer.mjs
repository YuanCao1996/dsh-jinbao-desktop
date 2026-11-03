import {parseChat,AUGMENT_VERB_RE} from './chat.mjs';
const normalized=value=>String(value??'').replace(/[\s:：!！·•,，。.]/g,'').toLowerCase();
function lookup(map,value){
  if(value.startsWith('~fix~'))return null;
  if(value.startsWith('~prefix~')){
    const prefix=normalized(value.slice(8));if(prefix.length<2)return null;
    const matches=[...map].filter(([key])=>key.startsWith(prefix));
    return matches.length===1?matches[0][1].name:null;
  }
  return map.get(normalized(value))??null;
}
export function createChatObserver(augmentNames,emit){
  let champions=[],items=[],seen=new Map();
  const augments=new Map(augmentNames.map(name=>[normalized(name),{name}]));
  return {
    reset(){seen.clear();},
    setCatalog(catalog){champions=catalog.champions??champions;items=catalog.items??items;},
    observe(frame,state){
      if(!frame?.available||!frame.foreground||!state)return;
      const aliases=new Map();
      for(const c of champions)for(const name of [c.name,c.alias])if(name)aliases.set(normalized(name),c.name);
      const players=[state.me,...state.allies,...state.enemies].filter(p=>p?.champion);
      for(const p of players){const canonical=aliases.get(normalized(p.championAlias))??p.champion;for(const name of [p.champion,p.championAlias])if(name)aliases.set(normalized(name),canonical);}
      const itemMap=new Map(items.filter(i=>i?.name).map(i=>[normalized(i.name),i]));
      for(const p of players)for(const item of p.items??[])if(item?.name)itemMap.set(normalized(item.name),item);
      const championsInText=value=>{
        const text=normalized(value),hits=[];
        for(const [alias,name] of aliases){const at=text.indexOf(alias);if(at>=0)hits.push({name,at});}
        return [...new Set(hits.sort((a,b)=>a.at-b.at).map(h=>h.name))];
      };
      const lines=(frame.lines??[]).filter(line=>Array.isArray(line.box)).map(line=>({...line,text:String(line.text??'').replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g,'$1').replace(/(\d)\s*[:：]\s*(\d)/g,'$1:$2')}));
      const messages=parseChat(lines,{width:frame.width,height:frame.height,
        championsInText,isChampion:value=>aliases.has(normalized(value)),championFix:value=>aliases.get(normalized(value))??null,
        augmentLookup:value=>lookup(augments,value),itemLookup:value=>lookup(itemMap,value),
        augmentsInText:value=>{
          const text=normalized(value);
          const hits=[...augments].filter(([key])=>text.includes(key));
          // 虹吸 is a substring of 灵魂虹吸 (and 棱彩阶 of 质变：棱彩阶), so a single
          // announcement matched two catalog entries and emitted two events. Keep only
          // the longest matching name.
          return hits.filter(([key])=>!hits.some(([other])=>other!==key&&other.includes(key))).map(([,row])=>row.name);
        },
      });
      for(const message of messages){
        if(!['purchase','augment_mutate','augment_picked_chat'].includes(message.kind))continue;
        // Chat attribution must read the raw line. The in-game format is
        // "玩家名（英雄）已质变了…", so stripping the bracketed prefix before looking
        // for the champion loses the owner, and when the augment itself is bracketed
        // the greedy strip also swallows the verb, forcing every line to low confidence.
        const raw=String(message.text??'');
        const verbAt=raw.search(AUGMENT_VERB_RE);
        const beforeVerb=verbAt>=0?raw.slice(0,verbAt):raw;
        const explicit=championsInText(beforeVerb).at(-1);
        const champion=explicit??message.champion??null;
        const ownName=aliases.get(normalized(state.me?.championAlias))??aliases.get(normalized(state.me?.champion))??state.me?.champion;
        const time=message.time??null;
        const names=message.kind==='purchase'?[message.item??null]:message.augments??[message.augment];
        // The parser already proved the verb was there; re-testing the joined line used to
        // disagree whenever OCR split the verb across boxes, which silently downgraded
        // every such record to low confidence and dropped it from the owned list.
        const told=message.verb===true||AUGMENT_VERB_RE.test(raw);
        const at=Date.now();
        for(const name of names){
          if(message.kind!=='purchase'&&!augments.has(normalized(name)))continue;
          // The same announcement is re-read across frames, and the in-game time is
          // missing on some of those reads. Keying on the time therefore let one line
          // through repeatedly (大力 appeared five times in a single match), so the key
          // is the fact itself and a short window absorbs the re-reads.
          const key=JSON.stringify([message.kind,champion,name]);
          const last=seen.get(key);
          // Purchases may legitimately repeat within seconds (two of the same item), so
          // they only absorb immediate re-reads. Attributed augment picks are minutes
          // apart, so a wide window is safe; an unattributed one is shared by every
          // player in the match, so it must expire quickly or two players picking the
          // same augment collapse into a single event.
          // An attributed augment is unique per player and match, so a minute of re-reads
          // is still the same fact; unattributed lines are shared by everyone in the match
          // and must expire quickly or two players collapse into one event.
          const window=message.kind==='purchase'?3000:champion?120000:6000;
          if(last!==undefined&&at-last<window)continue;
          seen.set(key,at);
          if(seen.size>512)seen.delete(seen.keys().next().value);
          if(message.kind==='purchase')emit({kind:'chat_events',gameTime:state.gameTime,events:[{kind:'purchase',champion,time,item:name,itemRaw:message.itemRaw??null,itemId:message.itemId??null,itemUnresolved:!name}]});
          else emit({kind:'augment_mutate',augment:augments.get(normalized(name)).name,champion,
            who:champion?(champion===ownName?'self':'other'):'unknown',
            source:'log-confirmed',confidence:told?'high':'low',time,gameTime:state.gameTime});
        }
      }
    },
  };
}
export function createChatCatalogReader(request){
  let lastPort=null,nextAttempt=0,busy=false;
  return async(credentials,accept)=>{
    if(busy||(lastPort===credentials.port&&Date.now()<nextAttempt))return;
    busy=true;lastPort=credentials.port;nextAttempt=Date.now()+60000;
    try{
      const results=await Promise.allSettled([
        request(credentials,'/lol-game-data/assets/v1/champion-summary.json'),
        request(credentials,'/lol-game-data/assets/v1/items.json'),
      ]);
      const data=results.map(r=>r.status==='fulfilled'&&r.value.status===200&&Array.isArray(r.value.data)?r.value.data:null);
      accept({...(data[0]?{champions:data[0]}:{}),...(data[1]?{items:data[1]}:{})});
      if(data.every(Boolean))nextAttempt=Infinity;
    }finally{busy=false;}
  };
}
