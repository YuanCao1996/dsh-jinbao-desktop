// Prefer the live game catalogue. This small fallback only recognizes stable
// finished item IDs/names; unknown items stay in raw facts, not UI reminders.
const finishedIds=new Set([3003,3006,3009,3020,3026,3031,3033,3036,3040,3041,3042,3046,3047,3050,3053,3065,3068,3071,3072,3073,3074,3075,3078,3083,3084,3085,3087,3089,3091,3094,3095,3100,3102,3107,3109,3110,3111,3115,3116,3118,3119,3121,3131,3137,3139,3142,3143,3152,3153,3156,3157,3158,3161,3165,3179,3181,3508,3742,3748,4005,4401,4628,4629,4633,4637,4645,4646,6653,6655,6656,6662,6664,6665,6667,6672,6673,6675,6676,6692,6694,6695,6696,6697,6698,6699,6701,8010,8020]);
const finishedNames=new Set(['残疫','影焰','无尽之刃','灭世者的死亡之帽','虚空之杖','巫妖之祸','兰德里的折磨','瑞莱的冰晶节杖','中娅沙漏','炽天使之拥','时光之杖','卢登的回声','黯炎火炬','荆棘之甲','水银弯刀','死亡之舞','饮血剑','收集者','疾射火炮','斯特拉克的挑战护手','法师之靴','水银之靴','铁板靴']);
export const baseItemId=id=>{const n=Number(id);return n>=220000&&n<230000?n-220000:n;};
export function isCompletedItem(item){
 if(item?.completed===false||item?.consumable===true)return false;
 if(item?.completed===true)return true;
 const name=typeof item==='string'?item:item?.name;
 return finishedIds.has(baseItemId(item?.id??item?.itemId))||finishedNames.has(name)||['焚天','心之钢','无终恨意'].includes(name);
}
export function createItemCatalogue(rows=[]){
 const map=new Map(),used=new Set();
 for(const row of rows){for(const id of row.from??[])used.add(Number(id));}
 for(const row of rows){
  const id=Number(row.id),into=row.into;
  const consumable=row.consumable===true||(row.categories??[]).some(v=>/consumable/i.test(v));
  const graphKnown=Array.isArray(into)||Array.isArray(row.from);
  const completed=consumable?false:graphKnown?!(Array.isArray(into)?into.length>0:used.has(id))&&(row.from?.length>0||Number(row.price??row.gold?.total)>=2000):undefined;
  map.set(id,{...(completed===undefined?{}:{completed}),consumable});
 }
 return item=>({...item,...(map.get(Number(item.id))??map.get(baseItemId(item.id))??{})});
}
