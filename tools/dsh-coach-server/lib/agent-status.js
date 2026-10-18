import {writeFile,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const labels={site_query:'已检索攻略',site_datasets:'已读取检索能力',web_search:'已联网搜索',web_fetch:'已读取网页',game_log_query:'已查询对局日志',game_memory_query:'已读取历史记忆',game_memory_save:'已保存明确偏好',inspect_latest_screen:'已处理画面请求'};
export function createAgentStatus(stateDir,game,match){
 let last=Promise.resolve();
 return (phase,name)=>{
  const label=phase==='start'?'智能体正在分析…':phase==='complete'?'':labels[name]?labels[name]+'，继续分析…':'智能体正在整理回答…';
  const value={game,match,label,at:Date.now()};
  last=last.catch(()=>{}).then(async()=>{await mkdir(stateDir,{recursive:true});const file=join(stateDir,'agent-status.json'),tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value),{mode:0o600});await rename(tmp,file);}).catch(()=>{});
 };
}
