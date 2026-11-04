import {rankedAugments,offerNames} from './augment-ranking.mjs';
import {isCompletedItem} from '../lol-companion/item-policy.mjs';

export function trackAugmentRound(state,event,previousOwned) {
  if(event.kind==='augment_offer'){
    const id=event.roll??state.offerRound??state.augmentRounds.length+1;
    let round=state.augmentRounds.find(r=>r.id===id);
    if(!round){round={id,options:[],confirmed:[],recommended:null};state.augmentRounds.push(round);}
    round.currentOptions=offerNames(state.offers);round.options=[...new Set([...round.options,...round.currentOptions])].slice(-6);round.closed=false;round.recommended=null;round.assumed=null;round.dismissed=false;
    state.augmentRounds=state.augmentRounds.slice(-12);
  }
  if(event.kind==='augment_offer_closed'){
    const round=state.augmentRounds.find(r=>r.id===(event.roll??state.offerRound));if(round){round.closed=true;round.closedAt=Number(event.t)||Date.now();
     // The player picked a card whose name never got read; remember which position so the
     // confirmation prompt can say which one is unknown instead of only a count.
     if(Number.isInteger(event.slot)&&event.slot>=0&&event.slot<3)round.unreadSlot=event.slot;}
  }
  if(event.kind==='augment_confirmation_dismissed'){const round=state.augmentRounds.find(r=>r.id===event.roll);if(round)round.dismissed=true;}
  if(event.kind==='augment_picked'&&event.who==='self'&&event.source==='countdown-default-confirmed'){
    const round=state.augmentRounds.find(row=>row.id===event.roll);
    if(round){round.assumed=event.augment??event.name;round.confirmationSource=event.source;round.recommended=null;}
  }
  const added=state.ownedAugments.filter(n=>!previousOwned.includes(n));
  if(added.length){
    const rounds=[...state.augmentRounds].reverse();
    // A late announcement from an earlier round must not confirm the panel that is open now:
  // that would suppress its confirmation dialog and attach the wrong augment to the round.
  // The last fallback only covers rounds whose options were never read.
  const round=state.augmentRounds.find(r=>r.id===event.roll)
   ??rounds.find(r=>!r.confirmed.length&&added.some(n=>r.options.includes(n)))
   ??rounds.find(r=>!r.confirmed.length&&!r.options.length);
    if(round){round.confirmed.push(...added);round.confirmationSource=event.source??'log-confirmed';round.assumed=null;round.recommended=null;}
  }
  const exact=state.augmentRounds.find(round=>round.id===event.roll);
  if(exact&&event.who==='self'&&event.confirmationId)exact.confirmationId=event.confirmationId;
  if(exact&&event.who==='self'&&exact.confirmed.includes(event.augment??event.name)&&event.source&&event.source!=='countdown-default-confirmed')exact.confirmationSource=event.source;
}

export function updateAugmentRecommendations(state,rows=[]){
  const ranked=rankedAugments(rows,state.me.champion);
  for(const round of state.augmentRounds){
    if(round.confirmed.length||round.assumed)continue;
    const best=ranked.find(row=>(round.currentOptions??round.options).includes(row.name)&&Number(row.rank)>0&&Number.isFinite(Number(row.rank)));
    if(best)round.recommended=best.name;
  }
}
const ownFacts=facts=>JSON.stringify([facts.hero,facts.currentItems.filter(isCompletedItem),facts.confirmedAugments,facts.assumedAugments]);
const decisionKey=(state,facts)=>JSON.stringify([state.game,state.match,state.matchStartedAt,ownFacts(facts),facts.enemies.map(e=>[e.hero,e.items.filter(isCompletedItem)]),facts.unassignedEnemyItems.filter(isCompletedItem)]);
const items=value=>(Array.isArray(value)?value:[]).map(i=>({name:typeof i==='string'?i:i?.name,count:i?.count??1,...(i?.id!=null?{id:i.id}:{}),...(typeof i?.completed==='boolean'?{completed:i.completed}:{})})).filter(i=>i.name);
export function equipmentContext(state){
  return {hero:state.me.champion,mode:state.mode,currentItems:items(state.me.items),
    enemies:state.enemies.map(p=>({hero:p.champion,items:items(p.items)})),
    unassignedEnemyItems:state.enemies.some(p=>items(p.items).length)?[]:items(state.enemyItems),
    confirmedAugments:[...state.ownedAugments],
    assumedAugments:state.augmentRounds.filter(r=>!r.confirmed.length&&(r.assumed||r.recommended)&&!state.ownedAugments.includes(r.assumed||r.recommended))
      .map(r=>({round:r.id,name:r.assumed||r.recommended,reason:r.assumed?'倒计时默认推测，尚未经本人确认':'未确认选择，按本轮当前候选中英雄适配排名最高项推测'}))};
}

export function createEquipmentCoach({getState,agentChat,save,onAdvice=()=>{},canRequest=()=>true,now=Date.now,debounceMs=2000,cooldownMs=30000,openingRetryMs=15000}){
  let pending='',since=0,lastAt=-Infinity,lastDone='',busy=false,closed=false,retryAt=0,lastConfirmed='';
  // 阵亡与开局都是"一次性事件"，不是"事实又变了"：它们各自只发一次，不走购买那次
  // 的防抖与冷却，否则玩家阵亡时正好撞上冷却就永远收不到提醒。
  let lastMatch='',opening={match:'',done:false,retryAt:0};
  const oneShot=(reason,question,{onSuccess=()=>{},onFailure=()=>{}}={})=>{
   busy=true;const current=getState(),match=current.match,started=current.matchStartedAt;
   void agentChat({game:current.game,match,question,topic:'equipment',automatic:true}).then(async answer=>{
    const now= getState();if(closed||now.ended||now.match!==match||now.matchStartedAt!==started)return;
    if(typeof answer!=='string'||!answer.trim())return;const text=answer.trim().slice(0,4000);
    if(reason==='opening')now.openingBuild=text;
    await onAdvice(now,text,reason);await save();onSuccess();
   }).catch(()=>{onFailure();}).finally(()=>{busy=false;});
  };
  return {
    tick(){
      const state=getState();
      if(closed||typeof agentChat!=='function'||!state.match||!state.me.champion||state.ended||state.phase==='ChampSelect'||now()-state.at>30000)return;
      if(state.match!==lastMatch){lastMatch=state.match;opening={match:state.match,done:false,retryAt:0};}
      // 开局加载完成、双方阵容都拿到了，给一份六件完整装备规划（每局一次）。
      // 大乱斗的加载阶段有时还看不到双方阵容，所以"刚进游戏且一件成装都没有"也算开局。
      const openingWindow=state.phase==='Loading'||(state.phase==='InProgress'&&!items(state.me.items).some(isCompletedItem));
      // A failed opening turn used to consume the one shot, so a busy or preempted model left the
      // player without the plan for the whole match. Keep retrying until it lands.
      if(!opening.done&&openingWindow&&state.allies.length&&state.enemies.length&&!busy&&canRequest()&&state.me.champion&&now()>=opening.retryAt){
       opening.retryAt=now()+openingRetryMs;
       oneShot('opening','【开局出装规划】对局加载完成，双方阵容已确定。请给出本局六件完整装备的购买顺序（含鞋子与关键小件），并说明针对点：对面谁的威胁最大、我方强化如何配合。现在是开局，不要假设已有任何成装。控制在300字内。\n【对局事实 JSON】\n'+JSON.stringify({hero:state.me.champion,allies:state.allies.map(p=>p.champion),enemies:state.enemies.map(p=>({hero:p.champion,items:items(p.items)})),confirmedAugments:[...state.ownedAugments]},{onSuccess:()=>{opening.done=true;}}));
      }
      const facts=equipmentContext(state);
      if(!facts.currentItems.length&&!facts.enemies.some(e=>e.items.length)&&!facts.unassignedEnemyItems.length&&!facts.confirmedAugments.length&&!facts.assumedAugments.length)return;
      const key=decisionKey(state,facts);
      if(key!==pending){pending=key;since=now();state.equipmentStatus=lastDone?'正在结合最新装备与海克斯更新建议…':'正在生成出装建议…';}
      // A confirmation changes the build inputs, so it must not wait for the cooldown or the
      // voice queue. The first turn has no baseline yet and keeps the previous behaviour.
      const confirmedKey=JSON.stringify(facts.confirmedAugments),urgent=lastConfirmed!==''&&confirmedKey!==lastConfirmed;
      if(busy||key===lastDone||now()<retryAt||(!urgent&&(now()-since<debounceMs||now()-lastAt<cooldownMs)))return;
      if(!canRequest()&&!urgent){state.equipmentStatus=lastDone?'低频更新中，已有出装建议仍可参考':'等待低频自动分析';return;}
      busy=true;lastAt=now();
      const match=state.match,started=state.matchStartedAt;
      const question='【自动出装建议任务】请结合当前装备、敌方各英雄装备、自己所有已确认海克斯，以及下列明确标注为推测的强化，更新出装建议。先给下一件优先购买的装备，再给后续顺序和针对性调整理由。推测强化必须写成“暂按…考虑，待确认”，不得宣称已拥有；所有已确认强化都要参与取舍。没有可信排名时不要编造推测。不要重复列出敌方装备明细或购买事件。玩法与装备数值不确定时调用工具查证。只用 coach_reply 提交不超过600字的最终建议。\n【装备决策事实 JSON】\n'+JSON.stringify(facts);
      void agentChat({game:state.game,match,question,topic:'equipment',automatic:true,...(urgent?{urgent:true}:{})}).then(async answer=>{
        const current=getState();
        if(closed||current.ended||current.match!==match||current.matchStartedAt!==started||current.game!==state.game||ownFacts(equipmentContext(current))!==ownFacts(facts))return;
        if(typeof answer==='string'&&answer.trim()){current.equipment=answer.trim().slice(0,4000);current.equipmentAssumptions=facts.assumedAugments;current.equipmentStatus=decisionKey(current,equipmentContext(current))===key?'':'敌方装备已变化，稍后更新建议';lastDone=key;lastConfirmed=confirmedKey;if(!current.equipmentStatus)await onAdvice(current,current.equipment);await save();}
      }).catch(error=>{
        const current=getState();
        if(error?.code==='auto_deferred'){lastAt=-Infinity;retryAt=Math.max(now()+3000,Number(error.retryAt)||0);if(!closed&&current.match===match&&!current.ended)current.equipmentStatus='等待低频自动分析';return;}
        if(!closed&&!current.ended&&current.match===match&&current.matchStartedAt===started){const interrupted=error?.code==='agent_preempted';if(interrupted){lastAt=-Infinity;retryAt=now()+1000;}if(decisionKey(current,equipmentContext(current))===key)current.equipmentStatus=interrupted?'已优先处理手动请求，稍后继续生成出装建议':'出装建议暂未生成，稍后自动重试';}
      }).finally(()=>{busy=false;});
    },
    close(){closed=true;},
    invalidate(){lastAt=-Infinity;},
  };
}
