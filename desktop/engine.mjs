import {inspectPixmax} from './pixmax.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {zipSync,unzipSync,strToU8,strFromU8} from 'fflate';
import {validateConnection,submitAPI,queryAPI,resolveOutput,runCLI,mediaSignature} from './adapters.mjs';

export const uid=()=>crypto.randomUUID();
const clone=v=>structuredClone(v);
const now=()=>new Date().toISOString();
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const delay=(ms,signal)=>sleep(ms,undefined,{signal});
export function relativeSafe(p){if(typeof p!=='string'||!p||p.includes('\\')||p.includes(':')||p.includes('\0')||p.startsWith('/')||p.split('/').some(x=>!x||x==='.'||x==='..'))throw new Error('不安全的项目文件路径');return p;}
export function validateProject(p){
 if(!p||p.schemaVersion!=='0.2.0-demo'||typeof p.id!=='string'||typeof p.title!=='string'||typeof p.script!=='string')throw new Error('这不是FilmDock 0.2 Demo项目文件');
 for(const k of ['shots','media','assets','timeline','tasks'])if(!Array.isArray(p[k])||p[k].length>5000)throw new Error('项目数据超出Demo范围');
 const ids=p.media.map(m=>m.id);if(new Set(ids).size!==ids.length)throw new Error('媒体ID重复');
 const shotIds=p.shots.map(s=>s.id);if(new Set(shotIds).size!==shotIds.length)throw new Error('镜头ID重复');
 for(const m of p.media){relativeSafe(m.path);if(!['image','video','audio'].includes(m.kind))throw new Error('媒体类型无效');}
 for(const s of p.shots){if(typeof s.id!=='string'||typeof s.description!=='string'||!Number.isFinite(s.duration)||s.duration<=0||s.duration>120)throw new Error('镜头数据无效');for(const key of ['keyframeId','videoId'])if(s[key]&&!ids.includes(s[key]))throw new Error('镜头的素材引用不存在');}
 for(const a of p.assets)if(a.mediaId&&!ids.includes(a.mediaId))throw new Error('资产引用不存在');
 for(const c of p.timeline){if(!ids.includes(c.mediaId)||!shotIds.includes(c.shotId))throw new Error('时间线素材引用不存在');if(!Number.isFinite(c.in)||!Number.isFinite(c.out)||c.in<0||c.out<=c.in||c.out-c.in>120)throw new Error('时间线入出点无效');const m=p.media.find(m=>m.id===c.mediaId);if(m.duration&&c.out>m.duration+.05)throw new Error('出点超过源素材时长');}
 if(!Number.isInteger(p.fps)||p.fps<1||p.fps>60)throw new Error('项目帧率无效');
 for(const k of ['width','height'])if(!Number.isInteger(p[k])||p[k]<16||p[k]>4096||p[k]%2)throw new Error('项目尺寸须为16至4096之间的偶数');
 return p;
}
function run(program,args,{cwd}={}){return new Promise((resolve,reject)=>{const c=spawn(program,args,{cwd,shell:false,windowsHide:true});let out='',err='';c.stdout.on('data',b=>out+=b.toString());c.stderr.on('data',b=>err=(err+b.toString()).slice(-2500));c.on('error',()=>reject(new Error('找不到媒体工具，请在连接设置中填写FFmpeg程序路径')));c.on('close',code=>code===0?resolve(out):reject(new Error(`媒体处理失败 ${code}：${err.slice(-300)}`)));});}
export class Engine{
 constructor({root,appDir,onEvent=()=>{},vault}){this.root=root;this.appDir=appDir;this.onEvent=onEvent;this.vault=vault;this.connections=[];this.controllers=new Map();this.queue=Promise.resolve();this.ffmpegPath='ffmpeg';}
 async init(){
  await fs.mkdir(path.join(this.root,'media'),{recursive:true});await fs.mkdir(path.join(this.root,'staging'),{recursive:true});
  try{const state=JSON.parse(await fs.readFile(path.join(this.root,'state.json'),'utf8'));this.project=validateProject(state.project);this.connections=state.connections||[];this.ffmpegPath=state.ffmpegPath||'ffmpeg';}
  catch(e){if(e.code!=='ENOENT')throw new Error('本地项目无法读取，原文件已保留；请备份后检查 workspace/state.json');this.project=JSON.parse(await fs.readFile(path.join(this.appDir,'seed.json'),'utf8'));}
  for(const t of this.project.tasks){if(['submitting','running','downloading'].includes(t.status))t.status=t.downloadSource?'download_failed':t.remoteId?'paused':'submission_unknown';if(t.status==='queued'){t.status='failed';t.error='应用在本地排队阶段退出，未自动提交，请自行重新发起。';}}
  await this.persist();return this.bootstrap();
 }
 publicConnections(){return this.connections.map(c=>({...c,hasSecret:this.vault.has(c.id)}));}
 async bootstrap(){return{project:clone(this.project),connections:this.publicConnections(),ffmpegPath:this.ffmpegPath,desktop:true,secretPersistent:this.vault.persistent};}
 persist(){const data=JSON.stringify({project:this.project,connections:this.connections,ffmpegPath:this.ffmpegPath});this.queue=this.queue.catch(()=>{}).then(async()=>{const tmp=path.join(this.root,'state.tmp');await fs.writeFile(tmp,data);await fs.rename(tmp,path.join(this.root,'state.json'));});return this.queue;}
 event(task,media){this.onEvent({task:clone(task),media:media?clone(media):null});}
 async saveProject(project){
  validateProject(project);if(project.id!==this.project.id)throw new Error('项目已切换，请重新打开');
  const media=this.project.media,tasks=this.project.tasks;
  this.project={...clone(project),media,tasks,updatedAt:now()};await this.persist();return{savedAt:this.project.updatedAt};
 }
 assertIdle(){if(this.controllers.size)throw new Error('请先等待或暂停正在运行的任务，再切换项目');}
 async newProject(title){this.assertIdle();this.project={schemaVersion:'0.2.0-demo',id:uid(),title:title||'未命名项目',subtitle:'新建创作项目',ratio:'16:9',fps:24,width:1280,height:720,script:'',shots:[],assets:[],media:[],tasks:[],timeline:[],updatedAt:now()};await this.persist();return this.bootstrap();}
 async resetDemo(){this.assertIdle();this.project=JSON.parse(await fs.readFile(path.join(this.appDir,'seed.json'),'utf8'));await this.persist();return this.bootstrap();}
 async saveConnections({connections,ffmpegPath}){
  if(!Array.isArray(connections)||connections.length>30)throw new Error('连接数量无效');
  const sanitized=[];
  for(const input of connections){const {token,clearSecret,hasSecret,...c}=input;validateConnection(c);if(clearSecret)await this.vault.delete(c.id);if(token)await this.vault.set(c.id,String(token));sanitized.push(c);}
  for(const old of this.connections)if(!sanitized.some(c=>c.id===old.id))await this.vault.delete(old.id);
  this.connections=sanitized;this.ffmpegPath=ffmpegPath?.trim()||'ffmpeg';await this.persist();return{connections:this.publicConnections(),secretPersistent:this.vault.persistent};
 }
 async checkConnection(id){const c=this.connections.find(c=>c.id===id);if(!c)throw new Error('请先保存连接');validateConnection(c);if(c.provider==='pixmax'){const status=await inspectPixmax(c,await this.vault.get(c.id));c.pixmaxStatus=status;if(status.model)c.model=status.model;if(status.fileUuid)c.fileUuid=status.fileUuid;await this.persist();return{...status,connections:this.publicConnections()};}if(c.type==='cli'){let resolved=c.program;if(!path.isAbsolute(resolved)){const dirs=(process.env.PATH||'').split(path.delimiter);const candidates=dirs.flatMap(d=>[path.join(d,c.program),...(process.platform==='win32'?[path.join(d,c.program+'.exe')]:[])]);resolved=null;for(const f of candidates){try{await fs.access(f);resolved=f;break;}catch{}}}if(!resolved)throw new Error('PATH中未找到该程序');await fs.access(resolved);return{message:'程序路径可用；未执行生成，请用一次实际任务验证协议'};}return{message:'API地址、模板和字段格式有效；未发送请求，也未验证账号权限'};}
 mediaPath(id){const m=this.project.media.find(m=>m.id===id);if(!m)throw new Error('找不到素材');return m.path.startsWith('builtin/')?path.join(this.appDir,relativeSafe(m.path)):path.join(this.root,relativeSafe(m.path));}
 async probe(file){try{const exe=path.isAbsolute(this.ffmpegPath)?path.join(path.dirname(this.ffmpegPath),process.platform==='win32'?'ffprobe.exe':'ffprobe'):'ffprobe';const raw=await run(exe,['-v','error','-show_format','-show_streams','-of','json',file]);const p=JSON.parse(raw),v=p.streams.find(x=>x.codec_type==='video');return{duration:Number(p.format.duration)||null,width:v?.width,height:v?.height,hasAudio:p.streams.some(x=>x.codec_type==='audio')};}catch{return{};}}
 async importBytes({name,bytes,shotId,assetId}){
  const b=Buffer.from(bytes);if(b.length>100*1024*1024)throw new Error('Demo单文件上限100MB');
  const kind=/\.(mp4|webm|mov)$/i.test(name)?'video':'image';const ext=mediaSignature(b,kind),id=uid(),rel=`media/${id}.${ext}`;
  await fs.writeFile(path.join(this.root,rel),b);const info=await this.probe(path.join(this.root,rel));
  const m={id,kind,path:rel,name:String(name).slice(0,160),shotId:shotId||null,assetId:assetId||null,...info,createdAt:now(),demo:false};this.project.media.push(m);await this.persist();return m;
 }
 async generate(input){
  if(input.clientRequestId){const existing=this.project.tasks.find(t=>t.clientRequestId===input.clientRequestId);if(existing)return clone(existing);}
  const target=input.assetId?this.project.assets.find(a=>a.id===input.assetId):this.project.shots.find(s=>s.id===input.shotId);
  if(!target)throw new Error('目标不存在');const c=input.connectionId==='demo'?null:this.connections.find(c=>c.id===input.connectionId);
  if(input.connectionId!=='demo'&&!c)throw new Error('连接不存在');if(c)validateConnection(c);
  if(c?.provider==='pixmax')throw new Error('Pixmax CLI 已接入配置，但此版本生成协议不兼容；请在连接页查看检查结果。未提交生成。');
  if(c&&!input.acknowledged)throw new Error('请先确认本次真实调用可能产生平台费用');
  if(!['image','video'].includes(input.kind)||(c&&c.outputKind!==input.kind))throw new Error('连接输出类型不匹配');
  const source=input.kind==='video'&&!input.assetId?target.keyframeId:null;
  const referenceInputs=[];if(source)referenceInputs.push({mediaId:source,role:'first_frame'});
  for(const a of this.project.assets.filter(a=>(target.assetIds||[]).includes(a.id)&&a.mediaId))if(!referenceInputs.some(r=>r.mediaId===a.mediaId))referenceInputs.push({mediaId:a.mediaId,role:a.type==='character'?'character_reference':a.type==='scene'?'scene_reference':'style_reference'});
  if(input.assetId&&target.mediaId)referenceInputs.push({mediaId:target.mediaId,role:'style_reference'});
  const task={id:uid(),clientRequestId:input.clientRequestId||uid(),status:'queued',kind:input.kind,shotId:input.shotId||null,assetId:input.assetId||null,connectionId:input.connectionId,connectionSnapshot:c?clone(c):null,name:target.title||target.name,prompt:String(input.prompt||target.prompt||target.description||''),duration:Math.min(30,Math.max(1,Number(input.duration)||target.duration||5)),referenceId:source,referenceInputs,createdAt:now(),demo:!c};
  this.project.tasks.unshift(task);await this.persist();this.execute(task,c).catch(()=>{});return clone(task);
 }
 async variables(t,c){const references=[];let total=0;for(const r of t.referenceInputs||(t.referenceId?[{mediaId:t.referenceId,role:'first_frame'}]:[])){const m=this.project.media.find(m=>m.id===r.mediaId);const file=this.mediaPath(r.mediaId);const bytes=await fs.readFile(file);total+=bytes.length;if(total>20*1024*1024)throw new Error('参考图片合计超过20MB');const ext=path.extname(file).slice(1);references.push({mediaId:m.id,role:r.role,...(c?.type==='cli'?{localPath:file}:{}),dataUri:`data:image/${ext==='jpg'?'jpeg':ext};base64,${bytes.toString('base64')}`});}const first=references.find(r=>r.role==='first_frame');return{requestId:t.id,prompt:t.prompt,model:c?.model||'',duration:t.duration,ratio:this.project.ratio,width:this.project.width,height:this.project.height,references,firstFrame:first?.dataUri||'',referencePath:first?.localPath||''};}
 async execute(t,c,resume=false){
  if(this.controllers.has(t.id))return;const ctl=new AbortController();this.controllers.set(t.id,ctl);
  try{
   t.status='running';this.event(t);await this.persist();
   let bytes;
   if(!c){await delay(900);if(ctl.signal.aborted)throw new Error('演示已暂停');const i=Math.max(0,this.project.shots.findIndex(s=>s.id===t.shotId))%6;bytes=await fs.readFile(path.join(this.appDir,`builtin/shot-${String(i+1).padStart(2,'0')}.${t.kind==='image'?'png':'mp4'}`));}
   else{
    const token=await this.vault.get(c.id),workDir=path.join(this.root,'staging',t.id);await fs.mkdir(workDir,{recursive:true});
    let result=t.downloadSource||null;
    if(!result&&!resume){t.status='submitting';await this.persist();this.event(t);const vars=await this.variables(t,c);if(c.type==='cli')result=await runCLI(c,vars,token,workDir,ctl.signal);else{const r=await submitAPI(c,vars,token,ctl.signal);t.remoteId=r.remoteId||null;result=r.result;await this.persist();}}
    if(!result&&t.remoteId&&c.type==='api'){
     t.status='running';this.event(t);await this.persist();
     let errors=0;
     for(let i=0;i<180;i++){
      if(ctl.signal.aborted)throw new Error('查询已暂停');
      try{const r=await queryAPI(c,t.remoteId,token,ctl.signal);errors=0;if(r.result){result=r.result;break;}t.remoteStatus=r.status;this.event(t);}catch(e){if(/远端任务结束|任务成功但未找到/.test(e.message)||++errors>=3)throw e;}
      await delay(Math.min(60,Math.max(1,Number(c.pollInterval)||5))*1000,ctl.signal);
     }
     if(!result)throw new Error('查询已达到Demo等待上限，可稍后恢复查询');
    }
    if(!result)throw new Error('没有可以恢复的远端ID或下载结果');
    t.status='downloading';t.downloadSource=result.buffer?null:result;await this.persist();this.event(t);
    bytes=await resolveOutput(result,c,token,ctl.signal,{workDir,allowFile:c.type==='cli'});
   }
   if(ctl.signal.aborted)throw new Error('任务已暂停');const ext=mediaSignature(bytes,t.kind),id=uid(),rel=`media/${id}.${ext}`;
   await fs.writeFile(path.join(this.root,rel+'.tmp'),bytes);await fs.rename(path.join(this.root,rel+'.tmp'),path.join(this.root,rel));
   const info=await this.probe(path.join(this.root,rel));
   const m={id,kind:t.kind,path:rel,shotId:t.shotId,assetId:t.assetId,name:t.name+(t.kind==='image'?' · 关键帧':' · 视频')+(t.demo?' · 演示':''),createdAt:now(),duration:t.kind==='video'?info.duration||t.duration:null,...info,demo:t.demo,taskId:t.id};
   this.project.media.push(m);t.status='succeeded';t.mediaId=id;t.finishedAt=now();delete t.downloadSource;await this.persist();this.event(t,m);
  }catch(e){t.status=ctl.signal.aborted?'paused':e.code==='SUBMISSION_UNKNOWN'?'submission_unknown':t.downloadSource?'download_failed':t.remoteId?'paused':'failed';t.error=ctl.signal.aborted?'本地等待已暂停；远端任务可能继续，请在平台核对。':String(e.message).slice(0,300);await this.persist();this.event(t);}finally{this.controllers.delete(t.id);}
 }
 async resumeTask(id){const t=this.project.tasks.find(t=>t.id===id),c=t?.connectionSnapshot||this.connections.find(c=>c.id===t?.connectionId);if(!t||!c||(!t.remoteId&&!t.downloadSource))throw new Error('无法自动恢复，请核对平台记录，不会重复提交');if(this.controllers.has(id))throw new Error('该任务仍在结束中，请稍后再恢复');this.execute(t,c,true).catch(()=>{});return true;}
 async pauseTask(id){const t=this.project.tasks.find(t=>t.id===id);if(!t)throw new Error('任务不存在');this.controllers.get(id)?.abort();t.status='paused';t.error='仅停止本地等待；远端生成可能继续计费，请在平台核对。';this.event(t);await this.persist();return true;}
 async exportZip(){
  const p=clone(this.project);validateProject(p);const files={};
  for(const t of p.tasks){delete t.downloadSource;delete t.remoteStatus;delete t.error;delete t.connectionSnapshot;}
  for(const m of p.media){const bytes=await fs.readFile(this.mediaPath(m.id));if(Object.values(files).reduce((n,b)=>n+b.length,0)+bytes.length>256*1024*1024)throw new Error('Demo交接包内容上限256MB');files[m.path]=new Uint8Array(bytes);}
  files['project.json']=strToU8(JSON.stringify(p,null,2));files['edit/timeline.json']=strToU8(JSON.stringify({fps:p.fps,clips:p.timeline},null,2));
  let cursor=0;const csv=[['clip_id','shot_id','media_id','source_path','source_in_frame','source_out_frame_exclusive','timeline_start_frame','duration_frames','fps'].join(',')];
  for(const c of p.timeline){const n=Math.round((c.out-c.in)*p.fps);csv.push([c.id,c.shotId,c.mediaId,p.media.find(m=>m.id===c.mediaId)?.path,Math.round(c.in*p.fps),Math.round(c.out*p.fps),cursor,n,p.fps].map(v=>`"${String(v??'').replaceAll('"','""')}"`).join(','));cursor+=n;}
  files['edit/cut_list.csv']=strToU8('\uFEFF'+csv.join('\n'));
  files['script/script.txt']=strToU8(p.script);
  files['README.md']=strToU8(`# ${p.title}\n\n使用FilmDock 0.2 Demo的“打开项目”导入此ZIP继续编辑。\n\n包括剧本、资产记录、镜头、全部已归档素材与粗剪清单。平台密钥和连接配置不在包中，继续真实生成需自行配置。\n\n演示素材：${p.media.filter(m=>m.demo).length}项。这些为代码绘制及简单动态演示，并非AI平台生成。\n\n本包不含自动渲染的成片，请在粗剪台单独导出MP4。该演示版交换格式与0.1需求草案不同，不兼容剪辑软件原生工程。\n`);
  const manifest={schemaVersion:'0.2.0-demo',projectId:p.id,createdAt:now(),files:Object.entries(files).map(([name,b])=>({path:name,size:b.length,sha256:sha(b)}))};
  files['manifest.json']=strToU8(JSON.stringify(manifest,null,2));return zipSync(files,{level:6});
 }
 async importZip(buffer){
  this.assertIdle();if(buffer.byteLength>100*1024*1024)throw new Error('Demo导入ZIP上限100MB');let total=0,count=0;const names=new Set();
  const files=unzipSync(new Uint8Array(buffer),{filter:f=>{relativeSafe(f.name);const folded=f.name.toLowerCase();if(names.has(folded))throw new Error('重复归档路径');names.add(folded);total+=f.originalSize;if(++count>10000||total>256*1024*1024)throw new Error('交接包展开量超限');return true;}});
  if(!files['manifest.json']||!files['project.json'])throw new Error('缺少项目或校验清单');const manifest=JSON.parse(strFromU8(files['manifest.json']));
  if(!Array.isArray(manifest.files))throw new Error('清单无效');const expected=new Set(['manifest.json']);
  for(const f of manifest.files){relativeSafe(f.path);if(expected.has(f.path))throw new Error('重复清单路径');expected.add(f.path);const b=files[f.path];if(!b||b.length!==f.size||sha(b)!==f.sha256)throw new Error(`文件校验失败：${f.path}`);}
  if(Object.keys(files).some(k=>!expected.has(k)))throw new Error('存在未声明文件');
  const p=validateProject(JSON.parse(strFromU8(files['project.json'])));
  for(const m of p.media){if(!files[m.path])throw new Error('交接包缺少媒体');const ext=mediaSignature(Buffer.from(files[m.path]),m.kind);const next=`media/${uid()}.${ext}`;await fs.writeFile(path.join(this.root,next),files[m.path]);m.path=next;}
  for(const t of p.tasks){delete t.downloadSource;if(!['succeeded','failed','submission_unknown'].includes(t.status))t.status='paused';}
  this.project=p;await this.persist();return this.bootstrap();
 }
 async renderMovie(output){
  const p=clone(this.project);validateProject(p);if(!p.timeline.length)throw new Error('请先把采用素材铺入时间线');
  const dir=path.join(this.root,'staging','render-'+uid());await fs.mkdir(dir,{recursive:true});const list=[];
  for(let i=0;i<p.timeline.length;i++){
   const c=p.timeline[i],m=p.media.find(m=>m.id===c.mediaId);if(!m||m.kind==='audio')throw new Error('时间线包含不支持的素材');
   const input=this.mediaPath(m.id),out=path.join(dir,`part-${i}.mp4`),duration=c.out-c.in;
   const args=['-y','-hide_banner','-loglevel','error',...(m.kind==='image'?['-loop','1']:['-ss',String(c.in)]),'-i',input,'-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000','-t',String(duration),'-vf',`scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease,pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2,fps=${p.fps},format=yuv420p`,'-map','0:v:0','-map',m.hasAudio&&!c.muted?'0:a:0':'1:a:0','-c:v','libx264','-preset','fast','-crf','23','-c:a','aac','-ar','48000','-ac','2','-shortest',out];
   await run(this.ffmpegPath,args);list.push(`file 'part-${i}.mp4'`);this.onEvent({renderProgress:Math.round((i+1)/(p.timeline.length+1)*100)});
  }
  await fs.writeFile(path.join(dir,'list.txt'),list.join('\n'));const temp=path.join(dir,'rough-cut.mp4');await run(this.ffmpegPath,['-y','-hide_banner','-loglevel','error','-f','concat','-safe','1','-i',path.join(dir,'list.txt'),'-c','copy','-movflags','+faststart',temp],{cwd:dir});await fs.copyFile(temp,output+'.tmp');await fs.rename(output+'.tmp',output);this.onEvent({renderProgress:100});return{output};
 }
}
