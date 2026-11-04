import {createHash} from 'node:crypto';
import {rankedAugments} from './augment-ranking.mjs';
export const augmentConfirmationId=(state,round)=>createHash('sha256').update(JSON.stringify([state.game,state.match,state.matchStartedAt,round.id,round.options])).digest('hex').slice(0,24);
// Only for an already accepted team result. This does not reopen an expired
// choice prompt; it finds the exact immutable round inside this live match.
export function acceptedTeamRound(state,id,name,now=Date.now()){
 if(state.game!=='lol'||state.ended||!state.match||!Number.isFinite(state.at)||now<state.at||now-state.at>30000)return null;
 return state.augmentRounds?.find(round=>round.closed&&!round.dismissed&&Array.isArray(round.options)&&round.options.includes(name)&&augmentConfirmationId(state,round)===id)??null;
}
export function augmentConfirmation(state,rows=[],now=Date.now(),{allowAssumed=false}={}){
 if(state.game!=='lol'||state.ended||!state.match||now-state.at>30000)return null;
 const round=[...state.augmentRounds].reverse().find(r=>r.closed&&(!r.confirmed.length&&!r.assumed||allowAssumed&&r.confirmationSource==='countdown-default-confirmed')&&!r.dismissed&&r.closedAt&&now-r.closedAt>=3000&&now-r.closedAt<120000);
 if(!round||!round.options.length)return null;
 const ranked=rankedAugments(rows,state.me.champion);
 // Only the cards currently on the panel can be confirmed. Rerolled-away names stay
 // in round.options for the "seen N/6" counter, but offering them here would let one
 // click record an augment this player never owned.
 const current=round.currentOptions??round.options;
 const names=[...ranked.filter(r=>current.includes(r.name)).map(r=>r.name),...current.filter(n=>!ranked.some(r=>r.name===n))];
 if(!names.length)return null;
 const missing=Math.max(0,3-current.length);
 return {id:augmentConfirmationId(state,round),
  round:round.id,title:'刚才选了哪个海克斯？',
  hint:missing?`按英雄适配排名排列，只列出当前面板上的候选；还有 ${missing} 个卡位未识别${Number.isInteger(round.unreadSlot)?`（你选的第 ${round.unreadSlot+1} 张没认出来）`:''}，未列出的不计入已选。`:'按英雄适配排名排列，只列出当前面板上的候选；未确认前仅作推测。',
  missing,
  options:names.map((name,i)=>({name,label:(i===0&&ranked.some(r=>r.name===name)?'优先推荐 · ':'')+name}))};
}
