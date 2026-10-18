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
