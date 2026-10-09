import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createSetupServer } from './server.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const name='jinbao-onboarding';
export const inject=['credentials','tools','systemPrompt'];
export const Config=z.object({port:z.number().default(3084),stateDir:z.string().default(join(homedir(),'.dsh','jinbao')),serviceBaseUrl:z.string().default('https://api.jinbaoai.top')});
export async function apply(ctx,cfg) {
 const setup=await createSetupServer({...cfg,credentials:ctx.credentials});
 ctx.effect(()=>()=>setup.close());
  ctx.tools.register(defineTool({name:'jinbao_settings',description:'Return local game-agent settings link; share only with the local user.',parameters:{},isConcurrencySafe:()=>true,output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:async()=>({url:setup.url})}));
  ctx.systemPrompt.section({name:'jinbao:setup',order:114,text:'Use jinbao_settings for login, model configuration and log diagnostics. Never put credentials in messages or tool arguments.'});

}
