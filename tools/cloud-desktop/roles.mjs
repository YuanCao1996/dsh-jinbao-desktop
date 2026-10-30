export { roles, roleById, roleInstruction } from '../shared/game-roles.mjs';
export function speechSegments(value,limit=6){
 const text=String(value??'').slice(0,6000).replace(/```[\s\S]*?```/g,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/https?:\/\/\S+/g,'').replace(/\b(?:Bearer\s+|(?:api[_ -]?key|token|secret|password)\s*[:=]\s*)\S+/gi,'凭据已隐藏').replace(/\bsk-[\w-]+/g,'凭据已隐藏').replace(/[*#`>|]/g,'').trim();
 const parts=[];let pending='';
 for(const phrase of text.match(/[^。！？；!?;\n]+[。！？；!?;\n]?/g)??[]){
  if(pending.length+phrase.length>85&&pending){parts.push(pending.trim());pending='';}
  pending+=phrase;while(pending.length>100){parts.push(pending.slice(0,85));pending=pending.slice(85);}
 }
 if(pending.trim())parts.push(pending.trim());return parts.filter(Boolean).slice(0,limit);
}
export const speechPause=text=>/[。！？；!?]$/.test(text?.trim()??'')?360:220;
// Do not cut an equipment/augment name or spend another model request summarizing.
export function briefSpeech(value,maxChars=60){
 const text=speechSegments(value,80).join('');let result='';
 for(const sentence of text.match(/[^。！？!?]+[。！？!?]?/g)??[]){
  const clean=sentence.trim();if(!clean||clean.length>maxChars)continue;
  if(result.length+clean.length>maxChars)break;result+=clean;
  if((result.match(/[。！？!?]/g)??[]).length>=2)break;
 }
 return result;
}
