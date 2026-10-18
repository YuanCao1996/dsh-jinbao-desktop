import {createHash} from 'node:crypto';
import {rankedAugments} from './augment-ranking.mjs';
export function augmentConfirmation(state,rows=[],now=Date.now()){
 if(state.game!=='lol'||state.ended||!state.match||now-state.at>30000)return null;
 const round=[...state.augmentRounds].reverse().find(r=>r.closed&&!r.confirmed.length&&!r.dismissed&&r.closedAt&&now-r.closedAt>=3000&&now-r.closedAt<120000);
 if(!round||!round.options.length)return null;
 const ranked=rankedAugments(rows,state.me.champion);
 const names=[...ranked.filter(r=>round.options.includes(r.name)).map(r=>r.name),...round.options.filter(n=>!ranked.some(r=>r.name===n))];
 return {id:createHash('sha256').update(JSON.stringify([state.game,state.match,state.matchStartedAt,round.id,round.options])).digest('hex').slice(0,24),
  round:round.id,title:'刚才选了哪个海克斯？',hint:'按英雄适配排名排列，点击实际选择；未确认前仅作推测。',
  options:names.map((name,i)=>({name,label:(i===0&&ranked.some(r=>r.name===name)?'优先推荐 · ':'')+name}))};
}
