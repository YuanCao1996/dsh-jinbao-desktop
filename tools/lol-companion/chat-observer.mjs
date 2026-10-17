import {parseChat} from './chat.mjs';
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
  let champions=[],items=[],seen=new Set();
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
        augmentsInText:value=>[...augments].filter(([key])=>normalized(value).includes(key)).map(([,row])=>row.name),
      });
      for(const message of messages){
        if(!['purchase','augment_mutate','augment_picked_chat'].includes(message.kind))continue;
        const body=String(message.text??'').replace(/^.*[)）]/,'');
        const subjectText=body.split(/已质变|已选择了/)[0];
        const explicit=championsInText(subjectText).at(-1);
        const champion=message.kind==='purchase'?message.champion??null:explicit??null;
        const ownName=aliases.get(normalized(state.me?.championAlias))??aliases.get(normalized(state.me?.champion))??state.me?.champion;
        const time=message.time??null;
        const names=message.kind==='purchase'?[message.item??null]:message.augments??[message.augment];
        for(const name of names){
          if(message.kind!=='purchase'&&!augments.has(normalized(name)))continue;
          const key=JSON.stringify([message.kind,time,champion,name]);if(seen.has(key))continue;seen.add(key);
          if(seen.size>512)seen.delete(seen.values().next().value);
          if(message.kind==='purchase')emit({kind:'chat_events',gameTime:state.gameTime,events:[{kind:'purchase',champion,time,item:name,itemId:message.itemId??null,itemUnresolved:!name}]});
          else emit({kind:'augment_mutate',augment:augments.get(normalized(name)).name,champion,
            who:champion?(champion===ownName?'self':'other'):'unknown',
            confidence:/已质变|已选择了/.test(body)?'high':'low',time,gameTime:state.gameTime});
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
