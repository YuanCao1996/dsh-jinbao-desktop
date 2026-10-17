// Read only visible selection facts. Never export summoner identifiers or hidden picks.
export function projectChampionSelection(session, champions) {
  const names=new Map(champions.filter(c=>Number(c.id)>0&&typeof c.name==='string').map(c=>[Number(c.id),c.name]));
  const project=row=>{const id=Number(row.championId||row.championPickIntent);return names.has(id)?{championId:id,champion:names.get(id)}:null;};
  const team=rows=>(Array.isArray(rows)?rows:[]).map(project).filter(Boolean);
  const own=(session.myTeam??[]).find(row=>row.cellId===session.localPlayerCellId);
  return {me:own?project(own)??{}:{},allies:team(session.myTeam),enemies:team(session.theirTeam),bench:team(session.benchChampions)};
}

export function createChampionSelectionReader(request) {
  let champions=[],port=null;
  return async credentials=>{
    const session=await request(credentials,'/lol-champ-select/v1/session');
    if(session.status!==200||!session.data||typeof session.data!=='object')return null;
    if(port!==credentials.port||!champions.length){
      const result=await request(credentials,'/lol-game-data/assets/v1/champion-summary.json');
      if(result.status!==200||!Array.isArray(result.data))return null;
      champions=result.data;port=credentials.port;
    }
    return projectChampionSelection(session.data,champions);
  };
}
