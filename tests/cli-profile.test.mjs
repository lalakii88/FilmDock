import test from 'node:test';
import assert from 'node:assert/strict';
import {zipSync,strToU8} from 'fflate';
import {inspectCliPackage,presentationStatus} from '../app/cli-profile.js';

test('portfolio ZIP import reads identity without executing package code',()=>{
  const bytes=zipSync({'bundle/setup.py':strToU8('raise Exception("must never execute")'),'bundle/pixmax/__main__.py':strToU8('raise Exception("must never execute")'),'bundle/pixmax/__init__.py':strToU8('__version__ = "1.2.3"'),'bundle/release/runtime.zip':new Uint8Array([1,2,3])});
  const profile=inspectCliPackage(bytes,'my-cli.zip');
  assert.equal(profile.packageName,'my-cli.zip');assert.equal(profile.packageVersion,'1.2.3');assert.equal(profile.presentation,true);assert.equal(profile.packageImported,true);
  const state=presentationStatus({...profile,outputKind:'video'});assert.equal(state.ready,true);assert.equal(state.demonstration,true);assert.equal(state.model,'demo-pixmax-video');
});
test('portfolio connections do not claim ready before import and invalid ZIPs are rejected',()=>{
  assert.equal(presentationStatus({}).ready,false);
  assert.throws(()=>inspectCliPackage(zipSync({'other.txt':strToU8('data')})),/未识别/);
  assert.throws(()=>inspectCliPackage(zipSync({'../escape':strToU8('bad')})),/不安全路径/);
});
