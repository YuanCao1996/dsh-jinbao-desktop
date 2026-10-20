import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
test('settings visibly switches from binding form to signed-in card and back on logout',async()=>{
 const html=await readFile(new URL('../settings.html',import.meta.url),'utf8');
 const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,{hidden:false,value:'',textContent:'',className:'',classes:new Set(),classList:{toggle(name,on){if(on)elements.get(id).classes.add(name);else elements.get(id).classes.delete(name);}},scrollIntoView(){},focus(){}}]));
 let method='ip-pilot';
 const context=vm.createContext({URL,Date,console,location:{hash:'#test',pathname:'/'},history:{replaceState(){}},document:{hidden:false,getElementById:id=>elements.get(id)},setInterval(){},setTimeout(){},clearTimeout(){},window:{open(){}},fetch:async(url,options={})=>{
  const route=url.replace('/api/','');
  if(route==='status')return Response.json({mode:'cloud',emailEnabled:true,account:method?{loginMethod:method,features:{model:true,retrieval:true}}:null,phoneSync:{linked:true,enabled:true},mobileUrl:'https://api.jinbaoai.top/desktop/mobile',emailDisplay:'a***@example.com'});
  if(route==='login/email/send')return Response.json({challengeId:'a'.repeat(48),retryAfter:60});
  if(route==='login/email/verify')method='email';
  if(route==='logout')method=null;
  return Response.json({status:'approved'});
 }});
 vm.runInContext(html.match(/<script>([\s\S]*)<\/script>/)[1],context);
 await vm.runInContext('refresh(true)',context);
 assert.equal(elements.get('emailBind').hidden,false);
 elements.get('emailAddress').value='a@example.com';await vm.runInContext("sendEmail('bind')",context);
 elements.get('emailCode').value='123456';await elements.get('emailConfirm').onclick();
 assert.equal(elements.get('emailLogin').hidden,true);assert.equal(elements.get('signedIn').hidden,false);assert.ok(elements.get('accountCard').classes.has('success'));assert.match(elements.get('message').textContent,/登录成功/);
 await elements.get('logout').onclick();assert.equal(elements.get('emailLogin').hidden,false);assert.equal(elements.get('signedIn').hidden,true);
});
