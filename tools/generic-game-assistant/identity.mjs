// Evidence is scoped to a window session; repeated reads of one frame are not corroboration.
export function createIdentityTracker({now=Date.now}={}) {
  const fields=new Map();
  return {
    observe(identity={},frame) {
      for(const key of ['game_name','game_mode','game_version','game_phase']) {
        const item=identity[key];if(!item?.evidence?.length)continue;
        const previous=fields.get(key);
        const same=previous?.value===item.value;
        const frames=same?new Set(previous.frames):new Set();frames.add(frame);
        const confirmed=item.confidence!=='low' && frames.size>=2;
        if(key==='game_name' && previous && !same)fields.clear();
        fields.set(key,{...item,frames:new Set([...frames].slice(-3)),status:confirmed?'corroborated':'tentative',at:now()});
      }
      return this.snapshot();
    },
    snapshot(){return Object.fromEntries([...fields].filter(([,v])=>now()-v.at<60000).map(([k,{frames,...v}])=>[k,{...v,evidence:[...v.evidence]}]));},
    clear(){fields.clear();},
  };
}
