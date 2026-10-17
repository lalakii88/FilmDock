import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {inspectPixmax,validatePixmaxPlan,importPixmaxPackage,pixmaxCommand} from '../desktop/pixmax.mjs';

const connection={id:'pixmax-test',type:'cli',provider:'pixmax',program:'pixmax',args:'[]',outputKind:'image'};
test('Pixmax without login stops before online calls and never reports ready',async()=>{
  const calls=[];const result=await inspectPixmax(connection,'',async(c,args)=>{calls.push(args);return args[0]==='auth'?{loggedIn:false}:{};});
  assert.equal(result.loggedIn,false);assert.equal(result.ready,false);
  assert.equal(calls.some(a=>a.includes('--online')||a.includes('create')),false);
});
test('Pixmax reads existing context and permitted models; incompatible dry-run never writes',async()=>{
  const calls=[];const result=await inspectPixmax(connection,'',async(c,a)=>{
    calls.push(a);
    if(a[0]==='auth')return {loggedIn:true};
    if(a[0]==='session')return {environment:'cn',file_uuid:'canvas-1'};
    if(a[0]==='config')return {effective:{environment:'cn'}};
    if(a.includes('--online'))return {checks:[{name:'onlineAuth',status:'pass'}]};
    if(a[0]==='model')return {models:[{canvasNodeType:'GENERATE_IMAGE',modelCode:'allowed'},{canvasNodeType:'GENERATE_IMAGE',modelCode:'blocked',restricted:true}]};
    if(a[0]==='node')return {plans:[{endpoint:'/canvas/node/batch',payload:{fileUuid:'canvas-1',create:[{uuid:'a',type:'GENERATE_IMAGE',fileUuid:'canvas-1',isGenerateNode:true,params:{model:'allowed'},prevNodeUuids:[],metaData:'{}'}]}}]};
    return {};
  });
  assert.equal(result.authVerified,true);assert.equal(result.fileUuid,'canvas-1');assert.equal(result.model,'allowed');assert.equal(result.models.length,1);assert.equal(result.ready,false);
  assert.ok(result.protocolErrors.includes('缺少画布 baseRevision'));
  assert.ok(result.protocolErrors.includes('节点含协议外字段'));
  assert.ok(calls.filter(a=>a[0]==='node').every(a=>a.includes('--dry-run')));
  assert.equal(calls.some(a=>a.includes('--run')||a[0]==='raw'),false);
});
test('Pixmax malformed plan is rejected',()=>assert.ok(validatePixmaxPlan({}, {fileUuid:'f',type:'GENERATE_IMAGE',model:'m'}).length));
test('Pixmax package import extracts runtime and rejects traversal before writing',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'filmdock-cli-'));
  try{
    const runtime=zipSync({'app/pixmax/__main__.py':strToU8('# fixture'),'vendor/click/__init__.py':strToU8('# fixture')});
    const result=await importPixmaxPackage(zipSync({'pixmax/release/runtime.zip':runtime}),root);
    assert.equal(JSON.parse(result.args)[0],'-m');assert.equal(await fs.readFile(path.join(result.runtimeRoot,'app/pixmax/__main__.py'),'utf8'),'# fixture');
    const bad=zipSync({'app/pixmax/__main__.py':strToU8(''),'vendor/click/__init__.py':strToU8(''),'../escape':strToU8('bad')});
    await assert.rejects(importPixmaxPackage(zipSync({'release/runtime.zip':bad}),root),/不安全路径/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('Pixmax runner passes arguments without a shell and keeps credentials out of errors',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'filmdock-cli-process-'));
  try{
    const script=path.join(root,'cli.cjs');await fs.writeFile(script,"console.log(JSON.stringify({args:process.argv.slice(2),tokenSet:!!process.env.PIXMAX_BEARER_TOKEN}));");
    const result=await pixmaxCommand({...connection,program:process.execPath,args:JSON.stringify([script])},['doctor','$(echo bad)','中文'],{token:'fixture-token'});
    assert.deepEqual(result.args,['--json','doctor','$(echo bad)','中文']);assert.equal(result.tokenSet,true);
    await fs.writeFile(script,"console.error(process.env.PIXMAX_BEARER_TOKEN);process.exit(1);");
    await assert.rejects(pixmaxCommand({...connection,program:process.execPath,args:JSON.stringify([script])},['doctor'],{token:'fixture-token'}),e=>!e.message.includes('fixture-token'));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
