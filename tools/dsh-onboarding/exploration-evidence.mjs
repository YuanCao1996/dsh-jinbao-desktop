import {createHash} from 'node:crypto';
/** A suggestion only; never changes an exploration record by itself. */
export function currentHeroSuggestion(view,now=Date.now()){
  if(!view||view.game!=='lol'||view.phase!=='InProgress'||!view.match||view.ended
      ||!Number.isFinite(view.updatedAt)||now-view.updatedAt<0||now-view.updatedAt>30000
      ||!Number.isFinite(view.selfIdentityAt)||now-view.selfIdentityAt<0||now-view.selfIdentityAt>30000)return null;
  // The overlay keeps the local player separately; playerRows may label the
  // local player as an ally when a full roster is present.
  if(typeof view.selfChampion!=='string')return null;
  const name=view.selfChampion.trim();
  if(!name||name==='未知英雄'||name.length>100||/[\x00-\x1f]/.test(name))return null;
  const alias=typeof view.selfChampionAlias==='string'&&/^[A-Za-z0-9]{1,40}$/.test(view.selfChampionAlias)?view.selfChampionAlias.toLowerCase():'';
  const matchKey=createHash('sha256').update(JSON.stringify([view.match,view.matchStartedAt])).digest('hex');
  return {game:'lol_pc',season:'',category:'英雄',entity:name,alias,matchKey};
}
export function currentModeSuggestion(view,now=Date.now()){
  const hero=currentHeroSuggestion(view,now);
  if(!hero||view.mode!=='KIWI')return null;
  return {game:'lol_pc',season:'',category:'模式',entity:'海克斯大乱斗',alias:'',matchKey:hero.matchKey};
}
