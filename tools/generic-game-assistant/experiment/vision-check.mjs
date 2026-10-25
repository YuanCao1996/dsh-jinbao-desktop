import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSdkHost } from './sdk-host.mjs';
import { loadSharedModel } from './shared-model.mjs';

if (!process.argv.includes('--allow-cloud')) throw new Error('explicit_cloud_test_required');
const arg = name => { const index=process.argv.indexOf(name); if(index<0||!process.argv[index+1])throw new Error('missing_test_argument'); return resolve(process.argv[index+1]); };
const folder=arg('--fixture-dir'),reportPath=arg('--report');
const png=await readFile(join(folder,'controlled.png'));
const rgb=await readFile(join(folder,'controlled.rgb'));
const truth=JSON.parse(await readFile(join(folder,'ground-truth.json'),'utf8'));
if(rgb.length!==truth.width*truth.height*3)throw new Error('invalid_fixture_pixels');
const sha256=createHash('sha256').update(png).digest('hex');
const sharedModel=await loadSharedModel();
const originalFetch=globalThis.fetch;let imageAttempts=0;
globalThis.fetch=async(input,options)=>{
  const body=typeof options?.body==='string'?JSON.parse(options.body):null;
  if(body?.messages?.some(message=>Array.isArray(message.content)&&message.content.some(part=>part.type==='image_url'))){
    if(++imageAttempts>1)throw new Error('controlled_image_call_limit');
  }
  return originalFetch(input,options);
};
const events=[],progress=[];let captures=0,requests=0;
const host=await createSdkHost({stateDir:resolve('state/vision-check-'+Date.now()),sharedModel,
  observer:{clear(){},select:async()=>({kind:'window',id:'generated-vision-fixture',authorized:true,width:truth.width,height:truth.height}),
    capture:async(request)=>{if(request?.roi&&(request.roi.x!==0||request.roi.y!==0||request.roi.width!==1||request.roi.height!==1))
      throw new Error('fixture_roi_not_supported');
      captures++;return{png,image:{width:truth.width,height:truth.height,rgb},
      frame:{target_id:'generated-vision-fixture',width:truth.width,height:truth.height,captured_at_ms:Date.now(),sha256,assistant_excluded:true},
      geometry:{pixel_roi:{x:0,y:0,width:truth.width,height:truth.height},source_size:{width:truth.width,height:truth.height},
        output_size:{width:truth.width,height:truth.height}}};}},
  specializedActive:async()=>false,log:value=>events.push(value),progress:value=>progress.push(value)});
host.ctx.on('agent/request',(_payload,next)=>{requests++;return next();});
const report={mode:'real_dsh_public_gateway_controlled_image',actual_game:false,
  native_window_capture:false,fixture:folder,image_sha256:sha256,model:sharedModel.summary};
const begin=Date.now();
try{
 await host.runtime.start({targetId:'generated-vision-fixture',authorized:true,allowCloudImages:true});
 report.result=await host.runtime.ask('请看一下当前画面，告诉我最上面写的验证码。');
 report.facts=host.runtime.state().facts;
 report.passed=report.result.status==='completed'&&report.result.text.includes(truth.code)
   &&report.facts?.texts.some(text=>text.includes(truth.code))
   &&progress.some(step=>step.tool==='generic_read_screen'&&step.phase==='completed');
}finally{
 report.elapsed_ms=Date.now()-begin;report.dsh_model_calls=requests;report.local_captures=captures;
 report.image_attempts=imageAttempts;report.image_call_limit=1;
 report.image_calls=events.filter(event=>event.event==='visual_http').length;report.progress=progress;report.events=events;
 await host.close();
 globalThis.fetch=originalFetch;
 const secret=(await sharedModel.resolveCredential()).value;
 if(JSON.stringify(report).includes(secret)||JSON.stringify(report).includes(png.toString('base64')))throw new Error('private_data_in_report');
 await mkdir(dirname(reportPath),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2));
}
console.log(JSON.stringify({passed:report.passed,result:report.result,image_calls:report.image_calls,
  dsh_model_calls:requests,elapsed_ms:report.elapsed_ms,report:reportPath}));
if(!report.passed)process.exitCode=1;
