import {rankedAugments,offerNames} from './augment-ranking.mjs';

export function trackAugmentRound(state,event,previousOwned) {
  if(event.kind==='augment_offer'){
    const id=event.roll??state.offerRound??state.augmentRounds.length+1;
    let round=state.augmentRounds.find(r=>r.id===id);
    if(!round){round={id,options:[],confirmed:[],recommended:null};state.augmentRounds.push(round);}
    round.options=offerNames(state.offers);round.closed=false;round.recommended=null;
    state.augmentRounds=state.augmentRounds.slice(-12);
  }
  if(event.kind==='augment_offer_closed'){
    const round=state.augmentRounds.find(r=>r.id===(event.roll??state.offerRound));if(round)round.closed=true;
  }
  const added=state.ownedAugments.filter(n=>!previousOwned.includes(n));
  if(added.length){
    const rounds=[...state.augmentRounds].reverse();
    const round=state.augmentRounds.find(r=>r.id===event.roll)??rounds.find(r=>!r.confirmed.length&&added.some(n=>r.options.includes(n)))??rounds.find(r=>!r.confirmed.length);
    if(round){round.confirmed.push(...added);round.recommended=null;}
  }
}

export function updateAugmentRecommendations(state,rows=[]){
  const ranked=rankedAugments(rows,state.me.champion);
  for(const round of state.augmentRounds){
    if(round.confirmed.length)continue;
    const best=ranked.find(row=>round.options.includes(row.name)&&Number(row.rank)>0&&Number.isFinite(Number(row.rank)));
    if(best)round.recommended=best.name;
  }
}
const items=value=>(Array.isArray(value)?value:[]).map(i=>({name:typeof i==='string'?i:i?.name,count:i?.count??1})).filter(i=>i.name);
export function equipmentContext(state){
  return {hero:state.me.champion,mode:state.mode,currentItems:items(state.me.items),
    enemies:state.enemies.map(p=>({hero:p.champion,items:items(p.items)})),
    unassignedEnemyItems:state.enemies.some(p=>items(p.items).length)?[]:items(state.enemyItems),
    confirmedAugments:[...state.ownedAugments],
    assumedAugments:state.augmentRounds.filter(r=>!r.confirmed.length&&r.recommended&&!state.ownedAugments.includes(r.recommended))
      .map(r=>({round:r.id,name:r.recommended,reason:'未确认选择，按本轮当前候选中英雄适配排名最高项推测'}))};
}

export function createEquipmentCoach({getState,agentChat,save,now=Date.now,debounceMs=2000,cooldownMs=30000}){
  let pending='',since=0,lastAt=-Infinity,lastDone='',busy=false,closed=false;
  return {
    tick(){
      const state=getState();
      if(closed||typeof agentChat!=='function'||!state.match||!state.me.champion||state.ended||state.phase==='ChampSelect'||now()-state.at>30000)return;
      const facts=equipmentContext(state);
      if(!facts.currentItems.length&&!facts.enemies.some(e=>e.items.length)&&!facts.unassignedEnemyItems.length&&!facts.confirmedAugments.length&&!facts.assumedAugments.length)return;
      const key=JSON.stringify([state.game,state.match,state.matchStartedAt,facts]);
      if(key!==pending){pending=key;since=now();if(lastDone){state.equipment='正在结合最新装备与海克斯更新出装建议…';state.equipmentAssumptions=[];}}
      if(busy||key===lastDone||now()-since<debounceMs||now()-lastAt<cooldownMs)return;
      busy=true;lastAt=now();
      const match=state.match,started=state.matchStartedAt;
      const question='【自动出装建议任务】请结合当前装备、敌方各英雄装备、自己所有已确认海克斯，以及下列明确标注为推测的强化，更新出装建议。先给下一件优先购买的装备，再给后续顺序和针对性调整理由。推测强化必须写成“暂按…考虑，待确认”，不得宣称已拥有；所有已确认强化都要参与取舍。没有可信排名时不要编造推测。不要重复列出敌方装备明细或购买事件。玩法与装备数值不确定时调用工具查证。只用 coach_reply 提交不超过600字的最终建议。\n【装备决策事实 JSON】\n'+JSON.stringify(facts);
      void agentChat({game:state.game,match,question,topic:'equipment'}).then(async answer=>{
        const current=getState();
        if(closed||current.match!==match||current.matchStartedAt!==started||JSON.stringify([current.game,current.match,current.matchStartedAt,equipmentContext(current)])!==key)return;
        if(typeof answer==='string'&&answer.trim()){current.equipment=answer.trim().slice(0,4000);current.equipmentAssumptions=facts.assumedAugments;lastDone=key;await save();}
      }).catch(()=>{
        const current=getState();
        if(!closed&&current.match===match&&current.matchStartedAt===started&&JSON.stringify([current.game,current.match,current.matchStartedAt,equipmentContext(current)])===key){current.equipment='出装建议更新失败，稍后自动重试。';current.equipmentAssumptions=[];}
      }).finally(()=>{busy=false;});
    },
    close(){closed=true;},
  };
}
