import { spawn } from 'node:child_process';
import { appendFileSync,mkdirSync,statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'../..');
const adb=process.env.JINBAO_ADB_PATH??join(root,'runtime/platform-tools/adb.exe');
const folder=process.env.JINBAO_LOG_DIR??join(homedir(),'.dsh/jinbao/logs');
mkdirSync(folder,{recursive:true});
let part=1,file=join(folder,'wzry-'+Date.now()+'-'+part+'.jsonl'),pending=null;
const keep=/MOBA局内互动调用LLM|MOBA_TACTICAL_BRIEF_CONTENT|本地OCR识别结果|MINIMAP_HERO_ROSTER|MINIMAP_IDENTITY_MATCH|MINIMAP_YOLO_RESULT|TTS播报已写入对局/;
function flush(){if(!pending)return;if(keep.test(pending.message)){
 try{if(statSync(file,{throwIfNoEntry:false})?.size>20*1024*1024)file=join(folder,'wzry-'+Date.now()+'-'+(++part)+'.jsonl');
 appendFileSync(file,JSON.stringify({game:'wzry',...pending})+'\n','utf8');}catch{console.error('Could not write game log');}
}pending=null;}
const child=spawn(adb,['logcat','-v','threadtime','金宝-Screenshot:V','金宝-GameContext:V','金宝-GameState:V','金宝-AITrace:V','金宝-Minimap:V','金宝-MinimapIdentity:V','金宝-MinimapHeroNeural:V','金宝-MOBA:V','金宝-MobaBrief:V','金宝-MinimapRealtime:V','*:S'],{windowsHide:true});
child.stdout.setEncoding('utf8');
let buffer='';
child.stdout.on('data',chunk=>{buffer+=chunk.toString('utf8');const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){const match=line.match(/^(\d\d-\d\d\s+[\d:.]+)\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+([^:]+):\s?(.*)$/);if(match){flush();pending={timestamp:new Date().getFullYear()+'-'+match[1],tag:match[5].trim(),message:match[6]};}else if(pending&&pending.message.length<262144)pending.message+='\n'+line;}}});
child.stderr.on('data',()=>console.error('ADB: connect your phone, enable USB debugging and authorize this computer.'));
child.on('error',()=>console.error('ADB is unavailable. Set JINBAO_ADB_PATH to platform-tools adb.exe.'));
child.on('exit',()=>{flush();process.exitCode=0;});
const flushTimer=setInterval(flush,500);flushTimer.unref();
process.once('SIGINT',()=>{flush();child.kill();});
console.log('王者日志采集已启动。请连接手机并授权 USB 调试。日志目录：'+folder);
