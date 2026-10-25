import test from 'node:test';import assert from 'node:assert/strict';
import {visualSignature,significantChange} from '../visual-change.mjs';
test('minor noise does not accelerate captures; large transitions do',()=>{
 const frame=v=>({width:64,height:64,rgb:new Uint8Array(64*64*3).fill(v)});
 const base=visualSignature(frame(80));
 assert.equal(significantChange(base,visualSignature(frame(82))),false);
 assert.equal(significantChange(base,visualSignature(frame(180))),true);
 assert.equal(significantChange(null,base),true);
});
