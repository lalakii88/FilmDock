import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {unzipSync} from 'fflate';

// Run only an argument array; neither CLI paths nor prompts enter a shell.
export function pixmaxCommand(c, args, {token='',signal,timeout=60000}={}) {
  const prefix=JSON.parse(c.args||'[]');
  const env={...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'};
  if(c.runtimeRoot)env.PYTHONPATH=[path.join(c.runtimeRoot,'app'),path.join(c.runtimeRoot,'vendor')].join(path.delimiter);
  if(token)env.PIXMAX_BEARER_TOKEN=token;
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(new Error('操作已取消'));return;}
    const child=spawn(c.program,[...prefix,'--json',...args],{env,cwd:c.runtimeRoot||undefined,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let out='',done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const abort=()=>{child.kill();finish(new Error('Pixmax 操作已停止'));};
    const timer=setTimeout(()=>{child.kill();finish(new Error('Pixmax 响应超时；未自动重试'));},timeout);
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',b=>{out+=b.toString('utf8');if(out.length>8*1024*1024){child.kill();finish(new Error('Pixmax JSON 超过8MB限制'));}});
    // Do not surface stderr: upstream tools can include credentials in diagnostics.
    child.stderr.on('data',()=>{});
    child.stdin.on('error',()=>{});child.stdin.end();
    child.on('error',()=>finish(new Error('无法启动 Pixmax；请检查 CLI 或 Python 3.10+ 的程序路径')));
    child.on('close',code=>{
      if(code!==0){finish(new Error(`Pixmax 命令失败（${code}）；请在本机检查登录、环境或网络`));return;}
      try{const data=JSON.parse(out);if(data?.success===false||data?.error)throw new Error();finish(null,data);}catch{finish(new Error('Pixmax 没有返回有效的成功 JSON'));}
    });
  });
}

export function validatePixmaxPlan(plan,{fileUuid,type,model}) {
  const errors=[];
  const p=plan?.plans?.find(p=>p.endpoint==='/canvas/node/batch')?.payload;
  const n=p?.create?.[0];
  if(!p||p.fileUuid!==fileUuid||typeof p.baseRevision!=='string'||!p.baseRevision)errors.push('缺少画布 baseRevision');
  if(!n||p.create.length!==1||n.type!==type||n.params?.model!==model)errors.push('目标节点或模型不匹配');
  if(n){
    if(['fileUuid','isGenerateNode','metaDataPatch'].some(k=>k in n))errors.push('节点含协议外字段');
    if(!n.uuid||!Array.isArray(n.prevNodeUuids))errors.push('缺少节点标识或有序上游');
    if(n.defaultAssetUuid!=='')errors.push('缺少空 defaultAssetUuid');
    try{const m=JSON.parse(n.metaData);if(!Number.isFinite(m.position?.x)||!Number.isFinite(m.position?.y)||!m.width||!m.height)errors.push('缺少节点布局尺寸');}catch{errors.push('metaData 无效');}
  }
  return errors;
}

export async function inspectPixmax(c,token='',invoke=pixmaxCommand) {
  const options={token};
  await invoke(c,['doctor'],options);
  const config=await invoke(c,['config','show'],options);
  const auth=await invoke(c,['auth','login','status'],options);
  const session=await invoke(c,['session','status'],options);
  const state={installed:true,loggedIn:auth.loggedIn===true,environment:config.effective?.environment||session.environment||'',fileUuid:c.fileUuid||session.file_uuid||'',models:[],ready:false,protocolErrors:[],checkedAt:new Date().toISOString()};
  if(!state.loggedIn)return {...state,message:'CLI 已识别。请先在 Pixmax CLI 完成网页登录，再检查连接。'};
  const online=await invoke(c,['doctor','--online'],options);
  if(!online.checks?.some(x=>x.name==='onlineAuth'&&x.status==='pass'))return {...state,message:'CLI 已识别，但线上账号验证未通过。请检查登录和网络。'};
  state.authVerified=true;
  const type=c.outputKind==='video'?'GENERATE_VIDEO':'GENERATE_IMAGE';
  const result=await invoke(c,['model','search','--type',type],options);
  state.models=(result.models||[]).filter(m=>m.restricted!==true&&(m.canvasNodeType||m.nodeType)===type).map(m=>({code:m.modelCode,name:m.modelName||m.modelCode})).filter(m=>typeof m.code==='string');
  if(!state.fileUuid)return {...state,message:'账号已连接。请填写画布 UUID，或在 CLI 中选择默认项目和画布。'};
  await invoke(c,['canvas','summary','--file',state.fileUuid,'--no-prompts'],options);
  const model=c.model||state.models[0]?.code;
  if(!model||!state.models.some(m=>m.code===model))return {...state,message:'未找到可用模型；请选择当前输出类型下的模型。'};
  state.model=model;
  const plan=await invoke(c,['node','create','FilmDock compatibility check','--file',state.fileUuid,'--type',type,'--model',model,'--prompt','FilmDock connection check','--dry-run'],options);
  state.protocolErrors=validatePixmaxPlan(plan,{fileUuid:state.fileUuid,type,model});
  // This CLI does not expose stable client-supplied IDs for create. Until it does,
  // dry-run and actual create cannot be bound and safely recovered after a timeout.
  state.protocolErrors.push('node create 尚未提供可复用的客户端节点 UUID 与提交恢复协议');
  state.message='账号、画布和模型已连接；生成兼容性检查未通过：'+state.protocolErrors.join('；');
  return state;
}

export async function importPixmaxPackage(bytes,directory) {
  if(bytes.length>100*1024*1024)throw new Error('CLI 包超过100MB');
  let size=0;
  const entries=unzipSync(bytes,{filter:e=>{size+=e.originalSize;if(size>200*1024*1024)throw new Error('CLI 包解压后过大');return !e.name.endsWith('/');}});
  const runtimeKey=Object.keys(entries).find(k=>/(^|\/)release\/runtime\.zip$/.test(k));
  if(!runtimeKey)throw new Error('不是支持的 Pixmax CLI 包：缺少 release/runtime.zip');
  size=0;
  const runtime=unzipSync(entries[runtimeKey],{filter:e=>{size+=e.originalSize;if(size>200*1024*1024)throw new Error('Runtime 解压后过大');return !e.name.endsWith('/');}});
  if(!runtime['app/pixmax/__main__.py']||!runtime['vendor/click/__init__.py'])throw new Error('Pixmax Runtime 不完整');
  for(const name of Object.keys(runtime))if(name.includes('\\')||name.includes(':')||name.startsWith('/')||name.split('/').some(x=>!x||x==='.'||x==='..'))throw new Error('CLI 包含不安全路径');
  const root=path.join(directory,crypto.randomUUID());
  for(const [name,data] of Object.entries(runtime)){const file=path.join(root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,data);}
  return {runtimeRoot:root,args:JSON.stringify(['-m','pixmax'])};
}
