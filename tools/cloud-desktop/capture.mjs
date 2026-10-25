import{execFile}from'node:child_process';import{promisify}from'node:util';import{fileURLToPath}from'node:url';
const exec=promisify(execFile);
export function createCloudCapture({readState,capture=async game=>{
 const {stdout}=await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../dsh-coach-server/capture-game.ps1',import.meta.url)),'-Game',game],{windowsHide:true,timeout:12000,maxBuffer:900000});return JSON.parse(stdout.replace(/^\uFEFF/,''));
},now=Date.now}){
 return async({game,match})=>{
  const fresh=at=>Number.isFinite(at)&&at<=now()&&now()-at<30000;
  const valid=s=>s?.game===game&&s.match===match&&!s.ended&&fresh(s.updatedAt);
  if(!valid(readState()))return null;
  const frame=await capture(game);if(!valid(readState())||!frame.available||frame.game!==game||frame.mediaType!=='image/jpeg'||!fresh(frame.capturedAt))return null;
  return {game,match,captured_at_ms:frame.capturedAt,image_base64:frame.data};
 };
}
