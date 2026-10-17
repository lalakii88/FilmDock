import {zipSync,unzipSync,strToU8,strFromU8} from './vendor/fflate.js';
import {uid,clone} from './domain.js';

const URLS=new Map();let db,project,connections=[],listener=()=>{};
async function database(){if(db)return db;db=await new Promise((resolve,reject)=>{const r=indexedDB.open('filmdock-demo-media',1);r.onupgradeneeded=()=>r.result.createObjectStore('media');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});return db;}
async function putBlob(id,blob){const db=await database();await new Promise((resolve,reject)=>{const tx=db.transaction('media','readwrite');tx.objectStore('media').put(blob,id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});URLS.set(id,URL.createObjectURL(blob));}
async function getBlob(id){const db=await database();return new Promise((resolve,reject)=>{const r=db.transaction('media').objectStore('media').get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
function selectFile(accept,multiple=false){return new Promise(resolve=>{const i=document.createElement('input');i.type='file';i.accept=accept;i.multiple=multiple;i.onchange=()=>resolve([...i.files]);i.oncancel=()=>resolve([]);i.click();});}
function download(bytes,name,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([bytes],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000);}
async function load(){let raw;try{raw=JSON.parse(localStorage.getItem('filmdock-project'));}catch{}project=raw||await(await fetch('./seed.json')).json();try{connections=JSON.parse(localStorage.getItem('filmdock-connections')||'[]');}catch{}for(const m of project.media){if(m.path.startsWith('media/')){const b=await getBlob(m.id);if(b)URLS.set(m.id,URL.createObjectURL(b));}}return{project:clone(project),connections,desktop:false,secretPersistent:false,ffmpegPath:'ffmpeg'};}
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
export function mediaURL(m){return m?URLS.get(m.id)||(m.path.startsWith('builtin/')?'./'+m.path:''):'';}
export const browserAPI={
 bootstrap:load,
 saveProject:async p=>{project=clone(p);localStorage.setItem('filmdock-project',JSON.stringify(project));return{savedAt:new Date().toISOString()};},
 saveConnections:async x=>{connections=x.connections.map(({token,clearSecret,...c})=>({...c,hasSecret:false}));localStorage.setItem('filmdock-connections',JSON.stringify(connections));return{connections,secretPersistent:false};},
 checkConnection:async()=>({message:'浏览器预览仅检查配置格式，真实CLI/API调用请使用桌面客户端'}),
 newProject:async title=>{project={schemaVersion:'0.2.0-demo',id:uid(),title:title||'未命名项目',subtitle:'新建创作项目',ratio:'16:9',fps:24,width:1280,height:720,script:'',assets:[],shots:[],media:[],tasks:[],timeline:[],updatedAt:new Date().toISOString()};await browserAPI.saveProject(project);return{project:clone(project),connections,desktop:false,secretPersistent:false};},
 resetDemo:async()=>{localStorage.removeItem('filmdock-project');return load();},
 onEvent:fn=>{listener=fn;return()=>{listener=()=>{};};},
 importScript:async()=>{const f=(await selectFile('.txt,.md'))[0];return f?f.text():null;},
 importMedia:async target=>{const files=await selectFile('image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm',true),media=[];for(const f of files){if(f.size>100*1024*1024)throw new Error('单文件上限100MB');const id=uid(),m={id,kind:f.type.startsWith('video')?'video':'image',name:f.name,path:'media/'+id+'.'+f.name.split('.').pop(),...target,createdAt:new Date().toISOString(),demo:false};await putBlob(id,f);media.push(m);}return media;},
 generate:async input=>{if(input.connectionId!=='demo')throw new Error('真实CLI/API调用需在桌面客户端运行；此处可用演示连接');const task={id:uid(),kind:input.kind,shotId:input.shotId,assetId:input.assetId,name:'演示生成',status:'running',createdAt:new Date().toISOString(),demo:true};setTimeout(()=>{const i=Math.max(0,project.shots.findIndex(s=>s.id===input.shotId))%6;const m={id:uid(),kind:input.kind,name:input.kind==='image'?'关键帧 · 演示':'视频 · 演示',path:`builtin/shot-${String(i+1).padStart(2,'0')}.${input.kind==='image'?'png':'mp4'}`,shotId:input.shotId,assetId:input.assetId,createdAt:new Date().toISOString(),duration:input.kind==='video'?5:null,demo:true};listener({task:{...task,status:'succeeded',mediaId:m.id},media:m});},1200);return task;},
 pauseTask:async()=>{throw new Error('内置演示将在数秒内完成');},resumeTask:async()=>{throw new Error('桌面客户端支持恢复远端任务');},
 exportPackage:async()=>{
  const files={};for(const m of project.media){const b=m.path.startsWith('builtin/')?new Uint8Array(await(await fetch('./'+m.path)).arrayBuffer()):new Uint8Array(await(await getBlob(m.id)).arrayBuffer());files[m.path]=b;}
  const p=clone(project);for(const t of p.tasks){delete t.downloadSource;delete t.error;delete t.connectionSnapshot;}
  files['project.json']=strToU8(JSON.stringify(p,null,2));files['script/script.txt']=strToU8(p.script);files['edit/timeline.json']=strToU8(JSON.stringify({fps:p.fps,clips:p.timeline},null,2));
  files['README.md']=strToU8('# FilmDock Demo项目交接包\n\n用桌面客户端或浏览器预览的打开项目功能导入。内置图像为代码绘制概念图，视频为简单动态演示，并非AI生成。连接密钥不随包导出。\n');
  const manifest={schemaVersion:'0.2.0-demo',projectId:p.id,createdAt:new Date().toISOString(),files:[]};for(const[k,b]of Object.entries(files))manifest.files.push({path:k,size:b.length,sha256:await hash(b)});files['manifest.json']=strToU8(JSON.stringify(manifest,null,2));download(zipSync(files),p.title+'-FilmDock.zip','application/zip');return{file:'已下载交接包'};
 },
 openProject:async()=>{
  const f=(await selectFile('.zip'))[0];if(!f)return null;if(f.size>100*1024*1024)throw new Error('ZIP超过100MB');let total=0;const seen=new Set();const files=unzipSync(new Uint8Array(await f.arrayBuffer()),{filter:e=>{if(e.name.startsWith('/')||e.name.includes('\\')||e.name.includes(':')||e.name.split('/').some(p=>p==='..'||p==='.'||!p)||seen.has(e.name.toLowerCase()))throw new Error('不安全归档路径');seen.add(e.name.toLowerCase());total+=e.originalSize;if(total>256*1024*1024||seen.size>10000)throw new Error('归档内容过大');return true;}});
  if(!files['manifest.json']||!files['project.json'])throw new Error('缺少项目与校验清单');const manifest=JSON.parse(strFromU8(files['manifest.json']));const expected=new Set(['manifest.json']);for(const e of manifest.files){if(expected.has(e.path)||!files[e.path]||files[e.path].length!==e.size||await hash(files[e.path])!==e.sha256)throw new Error('项目校验失败');expected.add(e.path);}if(Object.keys(files).some(k=>!expected.has(k)))throw new Error('未声明的归档文件');
  const p=JSON.parse(strFromU8(files['project.json']));if(p.schemaVersion!=='0.2.0-demo'||!Array.isArray(p.shots)||!Array.isArray(p.media)||!Array.isArray(p.timeline)||!Array.isArray(p.assets)||!Array.isArray(p.tasks))throw new Error('项目版本不支持');
  for(const m of p.media){if(!files[m.path])throw new Error('媒体缺失');const type=m.kind==='video'?'video/'+(m.path.endsWith('.webm')?'webm':'mp4'):'image/'+(m.path.endsWith('.jpg')?'jpeg':m.path.split('.').pop());await putBlob(m.id,new Blob([files[m.path]],{type}));m.path='media/'+m.id+'.'+m.path.split('.').pop();}
  project=p;await browserAPI.saveProject(p);return{project:clone(p),connections,desktop:false,secretPersistent:false};
 },
 renderMovie:async()=>{throw new Error('MP4渲染需要桌面客户端与FFmpeg；浏览器可预览时间线和导出交接包');},
 chooseProgram:async()=>null,window:async()=>{}
};
