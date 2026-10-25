import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {claimInstance} from '../instance.mjs';

test('only one cloud client owns a state directory; closing releases the mutex',{skip:process.platform!=='win32',timeout:15000},async()=>{
 const dir=join(tmpdir(),'jinbao-mutex-'+randomUUID());
 const first=await claimInstance(dir);
 try{
  assert.equal(first.owned,true);
  const second=await claimInstance(dir);
  assert.equal(second.owned,false);await second.close();
 }finally{await first.close();}
 const recovered=await claimInstance(dir);
 try{assert.equal(recovered.owned,true);}finally{await recovered.close();}
});
