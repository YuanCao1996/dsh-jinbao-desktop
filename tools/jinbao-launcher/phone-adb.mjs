import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import net from 'node:net';
const exec=promisify(execFile);
export function createPhoneAdb({adb,spawnImpl=spawn,run=exec}){
 let child=null,port=null,starting=null,epoch=0;
 const env=()=>port?{ADB_SERVER_SOCKET:'tcp:127.0.0.1:'+port}:{};
 async function start(){
  if(child)return;if(starting)return starting;
  const generation=epoch;
  starting=(async()=>{
   const reservation=net.createServer();await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve);});
   port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
   if(generation!==epoch)throw Error('Phone ADB cancelled');
   const owned=spawnImpl(adb,['-L','tcp:'+port,'nodaemon','server'],{windowsHide:true,stdio:'ignore'});child=owned;
   const gone=()=>{if(child===owned)child=null;};owned.once('error',gone);owned.once('exit',gone);
   for(let i=0;i<40;i++){
    if(!child)throw Error('Phone ADB server unavailable');
    const ready=await new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});socket.setTimeout(100);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(false);});});
    if(ready)return;await new Promise(resolve=>setTimeout(resolve,50));
   }
   owned.kill();if(child===owned)child=null;throw Error('Phone ADB server timed out');
  })().finally(()=>{starting=null;});return starting;
 }
 async function close(){epoch++;const owned=child;child=null;if(owned){await new Promise(resolve=>{const timer=setTimeout(resolve,2000);owned.once('exit',()=>{clearTimeout(timer);resolve();});owned.kill();});}if(starting)await starting.catch(()=>{});port=null;}
 return {env,async run(args,options){await start();if(!child)throw Error('Phone ADB stopped');return run(adb,args,{...options,env:{...process.env,...env()}});},close};
}
