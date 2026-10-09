import { readFileSync,writeFileSync,existsSync,mkdirSync,cpSync,copyFileSync,readdirSync,renameSync } from 'node:fs';
import { join,resolve,dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseDocument,YAMLSeq } from '../../node_modules/yaml/dist/index.js';
const args=process.argv.slice(2),option=(k,d)=>args.includes(k)?args[args.indexOf(k)+1]:d;
const profiles=resolve(option('--profiles',join(homedir(),'.dsh','profiles')));
const state=resolve(option('--state',join(homedir(),'.dsh','jinbao')));
const source=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const patch=join(profiles,'desktop','cordis.patch.yml');
const original=existsSync(patch)?readFileSync(patch,'utf8'):'[]';
const doc=parseDocument(original,{customTags:[{tag:'tag:yaml.org,2002:js',resolve:value=>value}]});
if(doc.errors.length||!Array.isArray(doc.toJS()))throw Error('Desktop patch must be a valid YAML array');
function entries(seq){return [...seq.items.flatMap(n=>n?.get?.('insert') instanceof YAMLSeq?entries(n.get('insert')):[]),...seq.items];}
const all=entries(doc.contents);
const targets=[
{id:'jinbao-onboarding',name:'dsh-onboarding',config:{port:3084,stateDir:state}},
{id:'site-assistant',name:'dsh-game-services',config:{mode:'remote',serviceBaseUrl:'https://api.jinbaoai.top',tokenEnv:'JINBAO_SERVICE_TOKEN'}},
{id:'coach-server',name:'dsh-coach-server',config:{port:3081,provider:'jinbao-local',model:'jinbao-strategy',watchDir:join(state,'logs'),broadcastFile:join(state,'logs','coach_broadcasts.jsonl'),diagLogFile:join(state,'coach-server.log'),sessionCwd:state,coachPreset:'minimal',defaultGame:'wzry',visionEnabled:false,watchEnabled:true,liveTimeoutMs:120000}}
];
for(const target of targets){
 const found=all.filter(n=>n?.get?.('id')===target.id);if(found.length>1)throw Error('Duplicate plugin id: '+target.id);
 if(found[0]){found[0].set('name',target.name);found[0].set('disabled',false);found[0].set('config',target.config);}
 else doc.contents.add(doc.createNode({insert:[target]}));
}
function override(id,config){let node=all.find(n=>n?.get?.('id')===id);if(!node){node=doc.createNode({id,config:{}});doc.contents.add(node);}const previous=node.get('config')?.toJSON?.()??{};node.set('config',{...previous,...config});return node;}
const llm=all.find(n=>n?.get?.('id')==='llm-pi-ai')?.get('config')?.toJSON?.()??{};
override('llm-pi-ai',{providers:{...(llm.providers??{}),'jinbao-local':{displayName:'金宝游戏模型',api:'openai-completions',apiKeyEnv:'JINBAO_LOCAL_ACCESS_KEY',baseURL:'http://127.0.0.1:3084/v1',defaultInput:['text'],compat:{supportsStore:false,supportsDeveloperRole:false,supportsReasoningEffort:false,supportsUsageInStreaming:true,maxTokensField:'max_tokens'},models:[{id:'jinbao-strategy',name:'游戏策略（本机设置路由）',contextWindow:32768,maxTokens:2048}]}}});
let presets=all.find(n=>n?.get?.('id')==='agent-presets');
if(presets)presets.set('disabled',false);else doc.contents.add(doc.createNode({id:'agent-presets',disabled:false}));
if(args.includes('--dry-run')){console.log(doc.toString());process.exit(0);}
const bundled=join(source,'..','node_modules');
const releaseManifest=join(source,'..','manifest.json');
const dependencies=existsSync(releaseManifest)?JSON.parse(readFileSync(releaseManifest)).packages:['@deepseek-ai/schemastery','@deepseek-ai/cosmokit','@deepseek-ai/dsh-tools','@deepseek-ai/cordis','@deepseek-ai/cordis-plugin-loader','@deepseek-ai/dsh-scope','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-typert-protocol','@deepseek-ai/dsh-util-values','@deepseek-ai/dsh-util-crypto','@deepseek-ai/dsh-brand','@deepseek-ai/dsh-timeout','@deepseek-ai/dsh-session','yaml'];
for(const name of dependencies){const from=join(bundled,name,'package.json'),to=join(profiles,'node_modules',name,'package.json');if(existsSync(to)&&JSON.parse(readFileSync(from)).version!==JSON.parse(readFileSync(to)).version)throw Error('Existing dependency version differs: '+name+'; use a compatible DSH profile.');}
for(const name of dependencies)if(!existsSync(join(profiles,'node_modules',name)))cpSync(join(bundled,name),join(profiles,'node_modules',name),{recursive:true});
mkdirSync(dirname(patch),{recursive:true});mkdirSync(join(state,'logs'),{recursive:true});
for(const name of ['dsh-game-services','dsh-onboarding','dsh-coach-server']){
 const from=join(source,name),to=join(profiles,'node_modules',name);
 if(!existsSync(join(from,'package.json')))throw Error('Missing release plugin: '+name);
 cpSync(from,to,{recursive:true,filter:p=>!p.includes('tests')&&!p.includes('.bak')});
}
const updated=doc.toString();
if(updated!==original){if(existsSync(patch))copyFileSync(patch,patch+'.jinbao-'+Date.now()+'.bak');writeFileSync(patch+'.tmp',updated);renameSync(patch+'.tmp',patch);}
console.log('Installed. Restart DSH Desktop, then open Jinbao settings.');
