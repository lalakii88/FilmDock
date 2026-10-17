import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_OUTPUT=100*1024*1024;
export function pick(value, selector='') {
  if(!selector) return value;
  return selector.replace(/\[(\d+)\]/g,'.$1').split('.').filter(Boolean).reduce((v,k)=>{
    if(['__proto__','prototype','constructor'].includes(k)) throw new Error('不允许的字段路径');
    return v==null?undefined:v[k];
  },value);
}
export function template(value,vars) {
  if(typeof value==='string'){
    const full=value.match(/^\{\{([\w]+)\}\}$/);
    if(full){if(!(full[1] in vars)) throw new Error(`未知模板变量 ${full[1]}`);return vars[full[1]];}
    return value.replace(/\{\{([\w]+)\}\}/g,(_,k)=>{if(!(k in vars))throw new Error(`未知模板变量 ${k}`);return typeof vars[k]==='object'?JSON.stringify(vars[k]):String(vars[k]);});
  }
  if(Array.isArray(value))return value.map(v=>template(v,vars));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>{if(['__proto__','constructor','prototype'].includes(k))throw new Error('无效模板键');return[k,template(v,vars)];}));
  return value;
}
export function httpURL(value){const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('连接地址只支持不含账号密码的 HTTP 或 HTTPS');return u.toString();}
export function validateConnection(c){
  if(!c||typeof c.id!=='string'||!['api','cli'].includes(c.type))throw new Error('连接配置无效');
  if(!['image','video'].includes(c.outputKind))throw new Error('请选择图片或视频输出');
  if(c.type==='api'){
    httpURL(c.url);JSON.parse(c.bodyTemplate||'{}');
    const headers=JSON.parse(c.headers||'{}');if(!headers||Array.isArray(headers)||typeof headers!=='object')throw new Error('请求头必须为JSON对象');
    for(const key of Object.keys(headers))if(/authorization|api.?key|token|secret|cookie/i.test(key))throw new Error('鉴权信息请填写到单独的密钥栏');
    if(c.async){if(!c.pollUrl||!c.taskIdPath||!c.statusPath)throw new Error('异步API需要查询地址、任务ID和状态字段');httpURL(c.pollUrl.replace('{{taskId}}','test'));if(c.pollMethod==='POST')JSON.parse(c.pollBodyTemplate||'{}');}
  }else{
    if(!c.program?.trim())throw new Error('请填写 CLI 程序路径');
    if(/\.(bat|cmd|ps1)$/i.test(c.program))throw new Error('请使用可执行程序或解释器加脚本参数，避免 shell 拼接');
    const a=JSON.parse(c.args||'[]');if(!Array.isArray(a)||a.some(x=>typeof x!=='string'))throw new Error('CLI参数必须是字符串数组');
    if(c.tokenEnv&&!/^[A-Z_][A-Z0-9_]*$/i.test(c.tokenEnv))throw new Error('环境变量名格式无效');
  }
  return c;
}
export function authHeaders(c,token){const h={'Content-Type':'application/json',...JSON.parse(c.headers||'{}')};if(token)h[c.tokenHeader||'Authorization']=(c.tokenPrefix??'Bearer ')+token;return h;}
async function boundedBuffer(res,max=MAX_OUTPUT){
  const len=Number(res.headers.get('content-length'));if(len>max)throw new Error('结果超过100MB的Demo限制');
  const parts=[];let size=0;for await(const chunk of res.body){size+=chunk.byteLength;if(size>max)throw new Error('结果超过100MB的Demo限制');parts.push(Buffer.from(chunk));}return Buffer.concat(parts);
}
export async function fetchResponse(url,options={},signal){
  const res=await fetch(httpURL(url),{...options,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000)});
  if(!res.ok)throw new Error(`HTTP ${res.status}，请检查地址、账号权限与请求格式`);
  const buf=await boundedBuffer(res);
  if((res.headers.get('content-type')||'').includes('json')){try{return{json:JSON.parse(buf.toString('utf8'))};}catch{throw new Error('平台返回了无效JSON');}}
  if((res.headers.get('content-type')||'').match(/^(image|video)\//))return{buffer:buf};
  try{return{json:JSON.parse(buf.toString('utf8'))};}catch{throw new Error('预期返回JSON、图片或视频，实际响应不支持');}
}
export function parseResult(data,c){
  if(data.buffer)return{buffer:data.buffer};
  const output=pick(data.json,c.outputPath||'data.0.url');
  if(typeof output==='string'&&output.length)return c.outputFormat==='base64'?{base64:output}:c.outputFormat==='path'?{file:output}:{url:output};
  if(output&&typeof output==='object'){if(output.path)return{file:output.path};if(output.url)return{url:output.url};if(output.base64)return{base64:output.base64};}
  return null;
}
export async function submitAPI(c,vars,token,signal){
  const body=template(JSON.parse(c.bodyTemplate||'{}'),vars);
  let data;
  try{data=await fetchResponse(c.url,{method:'POST',headers:authHeaders(c,token),body:JSON.stringify(body)},signal);}catch(e){if(/HTTP (400|401|403|404|405|413|422)/.test(e.message))throw e;throw Object.assign(new Error('提交结果待确认，请核对平台订单后再决定是否重试'),{code:'SUBMISSION_UNKNOWN'});}
  const result=parseResult(data,c);if(result)return{result};
  const id=pick(data.json,c.taskIdPath||'id');
  if(c.async&&id!==undefined&&id!==null&&String(id).length)return{remoteId:String(id)};
  throw new Error('返回中没有找到输出；异步平台请检查任务ID字段');
}
export async function queryAPI(c,remoteId,token,signal){
  const url=c.pollUrl.replaceAll('{{taskId}}',encodeURIComponent(remoteId));
  const method=c.pollMethod==='POST'?'POST':'GET';
  const data=await fetchResponse(url,{method,headers:authHeaders(c,token),...(method==='POST'?{body:JSON.stringify(template(JSON.parse(c.pollBodyTemplate||'{}'),{taskId:remoteId}))}:{})},signal);
  const status=String(pick(data.json,c.statusPath||'status')??'').toLowerCase();
  if((c.failureValues||'failed,error,cancelled').split(',').map(x=>x.trim().toLowerCase()).includes(status))throw new Error(`远端任务结束：${status}`);
  const success=(c.successValues||'succeeded,completed,success').split(',').map(x=>x.trim().toLowerCase()).includes(status);
  if(success){const result=parseResult(data,c);if(!result)throw new Error('任务成功但未找到输出字段');return{result,status};}
  return{status:status||'remote_running'};
}
export async function resolveOutput(result,c,token,signal,{workDir,allowFile=false}={}){
  if(result.buffer)return result.buffer;
  if(result.base64){const s=result.base64.replace(/^data:[^;,]+;base64,/, '');if(s.length>MAX_OUTPUT*1.4)throw new Error('Base64结果过大');return Buffer.from(s,'base64');}
  if(result.file){
    if(!allowFile)throw new Error('HTTP平台不能要求读取本地文件');
    const file=path.isAbsolute(result.file)?result.file:path.resolve(workDir,result.file);
    const st=await fs.stat(file);if(!st.isFile()||st.size>MAX_OUTPUT)throw new Error('CLI输出文件不符合大小限制');return fs.readFile(file);
  }
  if(result.url){
    if(result.url.startsWith('data:'))return resolveOutput({base64:result.url},c,token,signal);
    const url=httpURL(result.url);const headers={};
    if(c.downloadWithAuth&&c.url&&new URL(url).origin===new URL(c.url).origin)Object.assign(headers,authHeaders(c,token));
    const res=await fetch(url,{headers,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000)});
    if(!res.ok)throw new Error(`下载失败 HTTP ${res.status}，可以恢复下载`);
    return boundedBuffer(res);
  }
  throw new Error('没有可用输出');
}
export async function runCLI(c,vars,token,workDir,signal){
  const inputFile=path.join(workDir,'request.json');
  const request={request_id:vars.requestId,prompt:vars.prompt,model:vars.model,duration:vars.duration,ratio:vars.ratio,references:vars.references,output_directory:workDir};
  await fs.writeFile(inputFile,JSON.stringify(request,null,2));
  const args=JSON.parse(c.args||'[]').map(a=>{const v=template(a,{...vars,inputFile,outputDir:workDir});return typeof v==='string'?v:JSON.stringify(v);});
  return new Promise((resolve,reject)=>{
    const env={...process.env};if(token&&c.tokenEnv)env[c.tokenEnv]=token;
    const child=spawn(c.program,args,{cwd:workDir,env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let text='',diagnostic='',ended=false;
    const finish=(err,value)=>{if(ended)return;ended=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);err?reject(err):resolve(value);};
    const abort=()=>{child.kill();finish(Object.assign(new Error('本地进程已停止；远端任务可能继续，请核对平台'),{code:'SUBMISSION_UNKNOWN'}));};
    const timer=setTimeout(()=>{child.kill();finish(Object.assign(new Error('CLI运行超时，远端状态待确认'),{code:'SUBMISSION_UNKNOWN'}));},Math.min(900,Math.max(10,Number(c.timeoutSeconds)||180))*1000);
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',b=>{text+=b.toString();if(text.length>2*1024*1024){child.kill();finish(new Error('CLI输出日志超过2MB限制'));}});
    child.stderr.on('data',b=>{diagnostic=(diagnostic+b.toString()).slice(-4096);});
    child.on('error',e=>finish(new Error(`无法启动CLI：${e.code||'请检查程序路径'}`)));
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request));
    child.on('close',code=>{
      if(code!==0){finish(new Error(`CLI退出码 ${code}，请在本机检查程序配置`));return;}
      const lines=text.split(/\r?\n/).filter(Boolean);let result=null;
      for(const l of lines){try{const j=JSON.parse(l);if(j.type==='result')result=parseResult({json:j.payload||j},c)||result;else result=parseResult({json:j},c)||result;}catch{}}
      if(!result){try{result=parseResult({json:JSON.parse(text)},c);}catch{}}
      finish(result?null:new Error('CLI没有返回可解析的输出JSON，请检查结果字段'),result);
    });
  });
}
export function mediaSignature(buffer,kind){
  if(buffer.length===0)throw new Error('输出文件为空');
  if(kind==='image'){
    if(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return'png';
    if(buffer[0]===255&&buffer[1]===216)return'jpg';
    if(buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')return'webp';
    if(buffer.toString('ascii',0,3)==='GIF')return'gif';
    throw new Error('输出不是支持的PNG、JPEG、WebP或GIF图片');
  }
  if(buffer.toString('ascii',4,8)==='ftyp')return'mp4';
  if(buffer.subarray(0,4).equals(Buffer.from([26,69,223,163])))return'webm';
  throw new Error('输出不是支持的MP4或WebM视频');
}
