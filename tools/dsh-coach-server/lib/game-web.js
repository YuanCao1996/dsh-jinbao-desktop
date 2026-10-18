import {HttpFetchProvider} from '@deepseek-ai/dsh-web-fetch-http';
export function gameSearchQuery(query,state={}){
 const q=String(query??'').trim();
 if(state.game==='lol'&&state.mode==='KIWI'&&/lol|league\s+of\s+legends|英雄联盟|海克斯|大乱斗|aram/i.test(q)&&!/王者|召唤师峡谷|经典模式|云顶|金铲铲|斗魂竞技场/.test(q)){
  return q+(!/mayhem|海克斯大乱斗/i.test(q)?' 海克斯大乱斗 ARAM Mayhem':'')+(!/20\d\d|\d{2}\.\d+|最新|当前版本/.test(q)?' 当前版本':'');
 }
 return q;
}
export function relevantGameSource(source,query){
 if(!/英雄联盟|海克斯|league\s+of\s+legends|aram|\blol\b/i.test(query))return true;
 let host;try{host=new URL(source.url).hostname.toLowerCase();}catch{return false;}
 if(/(?:^|\.)(?:iciba\.com|youdao\.com|dictionary\.cambridge\.org|merriam-webster\.com|dict\.cn)$/.test(host))return false;
 if(/(?:^|\.)(?:leagueoflegends\.com|riotgames\.com|lol\.qq\.com|metasrc\.com|lolalytics\.com|op\.gg|mobalytics\.gg|blitz\.gg)$/.test(host))return true;
 return /英雄联盟|海克斯|大乱斗|极地|league\s+of\s+legends|aram|\blol\b/i.test([source.title,source.snippet,source.description].join(' '));
}
export function cacheSearchProvider(provider,{readState=()=>({}),now=Date.now}={}){
 const cache=new Map(),inflight=new Map();
 return {id:provider.id,available:()=>provider.available(),async search(request,signal){
  const state=await readState(),query=gameSearchQuery(request.query,state),key=JSON.stringify([state.game,state.mode,query,request.maxResults]);
  const hit=cache.get(key);if(hit&&now()-hit.at<(/胜率|版本|更新|最新|statistics|patch/i.test(query)?600000:3600000))return structuredClone(hit.value);
  if(!inflight.has(key))inflight.set(key,provider.search({...request,query},AbortSignal.timeout(30000)).then(value=>{cache.set(key,{at:now(),value});if(cache.size>128)cache.delete(cache.keys().next().value);return value;}).finally(()=>inflight.delete(key)));
  const task=inflight.get(key);if(signal?.aborted)throw signal.reason;
  if(!signal)return structuredClone(await task);
  let cancel;const aborted=new Promise((_,reject)=>{cancel=()=>reject(signal.reason);signal.addEventListener('abort',cancel,{once:true});});
  try{return structuredClone(await Promise.race([task,aborted]));}finally{signal.removeEventListener('abort',cancel);}
 }};
}
export function decodeWebBytes(bytes,contentType=''){
 const declared=/charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
 const head=Buffer.from(bytes).subarray(0,8192).toString('latin1');
 const meta=/<meta\b[^>]*charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(head)?.[1];
 let charset=declared??meta??'utf-8';
 if(/utf-?8/i.test(charset)&&meta&&!/utf-?8/i.test(meta))try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{charset=meta;}
 const text=new TextDecoder(charset).decode(bytes);
 if((text.match(/\uFFFD/g)?.length??0)>Math.max(8,text.length*0.02))throw Error('网页正文编码不可靠，请换其他检索结果');
 return text;
}
export async function registerGameFetch(web){
 // Extend only native decoding. Native HTTP transport retains DNS pinning, public-address checks and redirect policy.
 class GameFetch extends HttpFetchProvider{
  async readBody(response,url,signal){
   const type=response.headers.get('content-type')??'';
   if(!/text\/|application\/(?:json|xml|xhtml)/i.test(type))return super.readBody(response,url,signal);
   const {bytes,truncatedByBytes}=await this.readCapped(response,signal);let text=decodeWebBytes(bytes,type);
   if(/html/i.test(type)&&text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<[^>]+>/g,'').replace(/\s/g,'').length<100)text+='<p>页面正文不足或需要脚本渲染，未获取完整攻略，不能据此确认胜率、装备数值或推荐。</p>';
   return {url:url.toString(),statusCode:response.status,body:{kind:/html/i.test(type)?'html':'text',content:text.slice(0,100000)},truncated:truncatedByBytes||text.length>100000};
  }
 }
 const provider=new GameFetch({maxResponseBytes:2000000,maxBodyChars:100000,timeoutMs:30000,maxRedirects:5,userAgent:'JinbaoGameCoach/1.0'});provider.id='jinbao-http';web.registerFetchProvider(provider);
}
