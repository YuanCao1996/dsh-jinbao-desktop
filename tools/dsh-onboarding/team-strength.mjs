// Configurable heuristic weights; these are not a calibrated match predictor.
export const TIER_WEIGHTS = Object.freeze({T0:1.2,T1:1.1,T2:1,T3:0.9,T4:0.8,T5:0.7});
export function teamStrength(rows,side){
  const team=rows.filter(row=>row.side===side);
  const usable=team.filter(row=>Number.isFinite(row.winRate)&&row.winRate>=0&&row.winRate<=100&&Object.hasOwn(TIER_WEIGHTS,row.tierText));
  if(team.length!==5||usable.length!==5)return {value:null,known:usable.length};
  const total=usable.reduce((sum,row)=>sum+TIER_WEIGHTS[row.tierText],0);
  return {value:Math.min(100,Math.max(0,usable.reduce((sum,row)=>sum+row.winRate*TIER_WEIGHTS[row.tierText],0)/total)),known:5};
}
export const TEAM_STRENGTH_NOTE='英雄样本胜率按强度加权：T0×1.2、T1×1.1、T2×1、T3×0.9、T4×0.8、T5×0.7，再除以权重总和。任一英雄胜率或强度缺失时不估算。属于启发式样本指标，不是本局获胜概率，双方不要求合计100%。';
export function liveTeamEstimate(rows,{seconds,allyKills,enemyKills,sideSource}={}){
 if(!Number.isFinite(seconds)||seconds<0||![allyKills,enemyKills].every(n=>Number.isInteger(n)&&n>=0)||sideSource==='assumed-ORDER')return null;
 const ally=teamStrength(rows,'友'),enemy=teamStrength(rows,'敌');
 const known=ally.value!==null&&enemy.value!==null;
 const logit=n=>Math.log(Math.max(.05,Math.min(.95,n/100))/(1-Math.max(.05,Math.min(.95,n/100))));
 const tier=side=>rows.filter(r=>r.side===side).reduce((sum,r)=>sum+(TIER_WEIGHTS[r.tierText]??1),0)/5;
 const prior=known?logit(ally.value)-logit(enemy.value)+.6*(tier('友')-tier('敌')):0;
 const minutes=Math.min(40,seconds/60),total=allyKills+enemyKills;
 const score=prior/(1+minutes/15)+(allyKills-enemyKills)*(.05+.003*minutes)/(1+total/80);
 const value=Math.round(Math.max(5,Math.min(95,100/(1+Math.exp(-score))))*10)/10;
 return {ally:value,enemy:Math.round((100-value)*10)/10,allyKills,enemyKills,heroPriorKnown:known};
}
export const LIVE_ESTIMATE_NOTE='局势估计：用英雄样本与强度作先验，随对局时间降低先验权重，再加入双方团队击杀差；双方合计100%。这是未经对局结果校准的启发式估计，不是统计胜率或胜负保证；英雄资料缺失时使用中性先验，未计入经济、建筑和复活时间等因素。';
