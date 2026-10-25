import {cleanGameData} from '../dsh-coach-server/lib/game-memory.js';

const short=value=>typeof value==='string'?value.slice(0,180):'';
const names=value=>Array.isArray(value)?value.slice(0,8).map(item=>short(typeof item==='string'?item:item?.name)).filter(Boolean):[];
function project(row,kind,query){
 let e=row.event??{};
 if(e.kind==='external_log'){const raw=String(e.text??''),at=query?raw.toLowerCase().indexOf(query.toLowerCase()):0;return{kind:'external_log',time:short(row.time??e.time),text:raw.slice(Math.max(0,at-100),Math.max(0,at-100)+1000),details:''};}
 if(e.kind==='chat_events'){
  const matches=(Array.isArray(e.events)?e.events:[]).filter(child=>child&&typeof child==='object'&&(!kind||child.kind===kind)&&(!query||JSON.stringify(child).toLowerCase().includes(query.toLowerCase())));
  const children=matches.slice(0,2).map(child=>Object.fromEntries(['kind','time','gameTime','champion','item','augment','name','who','confidence'].filter(k=>child[k]!==undefined).map(k=>[k,typeof child[k]==='string'?short(child[k]):child[k]])));
  e={...e,text:matches.length>2?'本记录只展示前2条匹配事件，请用更具体关键词查询剩余事件。':'聊天解析事件',nestedEvents:children};
 }
 const observation=e.state??e.me;
 if(observation&&typeof observation==='object')e={...e,observedState:{...Object.fromEntries(['time','champion','level','gold','dead','hpPct','k','d','a','teamKills','enemyKills','canShop'].filter(k=>observation[k]!==undefined).map(k=>[k,observation[k]])),items:names(observation.items)}};
 if(Array.isArray(e.options))e={...e,candidates:names(e.options)};
 if(['augment_picked','augment_mutate','augment_picked_chat'].includes(e.kind))e={...e,selection_status:e.confidence==='low'||e.source==='ocr-inferred'?'unconfirmed':e.source==='countdown-default-confirmed'?'default_confirmed':e.source==='user-confirmed'?'user_confirmed':'observed'};
 const seconds=e.gameSeconds??e.gameTime??e.state?.time??e.time;
 const time=typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>=0?
  String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(Math.floor(seconds%60)).padStart(2,'0'):
  typeof seconds==='string'&&/^\d{1,3}:\d{2}$/.test(seconds)?seconds:'时间未知';
 const details=Object.fromEntries(['champion','who','role','item','augment','name','phase','roll','reroll','confidence','selection_status','nestedEvents','observedState','candidates'].filter(k=>e[k]!==undefined).map(k=>[k,typeof e[k]==='string'?short(e[k]):e[k]]));
 const original=typeof (e.text??e.broadcast??e.message)==='string'?(e.text??e.broadcast??e.message):'';
 const position=query?original.toLowerCase().indexOf(query.toLowerCase()):-1,start=Math.max(0,position-40);
 const text=(start?'…':'')+original.slice(start,start+300)+(original.length>start+300?'…':'');
 const result=cleanGameData({kind:short(e.kind),time,text,details:JSON.stringify(details)});
 if(Buffer.byteLength(JSON.stringify(result))>1200)return {kind:short(e.kind),time,text:'记录字段较大，请使用更具体的关键词查询。',details:''};
 return result;
}

export function createEventQuery(memory){
 return async({game,match,args={}})=>{
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['query','kind','cursor','limit'].includes(k)))throw Error('Invalid event query');
  const {query='',kind='',cursor=0,limit=6}=args;
  if(typeof query!=='string'||query.length>100||typeof kind!=='string'||!/^[-a-z_0-9]{0,40}$/.test(kind)||!Number.isSafeInteger(cursor)||cursor<0||!Number.isInteger(limit)||limit<1||limit>10)throw Error('Invalid event query');
  let page,position=cursor;
  // Scan locally across sparse raw state records, while returning only one small
  // result page. At most 8 bounded reads (4 MB) per Agent request.
  for(let scans=0;scans<8;scans++){
   page=await memory.query({game,match,query,kind,cursor:position,limit});
   if(page.rows.length||page.nextCursor===null||page.nextCursor<=position)break;
   position=page.nextCursor;
  }
  if(page.game!==undefined&&(page.game!==game||page.match!==match))throw Error('Match scope conflict');
  const result={status:'ok',rows:page.rows.map(row=>project(row,kind,query)),next_cursor:page.nextCursor??null};
  if(Buffer.byteLength(JSON.stringify(result))>14000)throw Error('Event result too large');
  return result;
 };
}
