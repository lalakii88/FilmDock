import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {unzipSync,zipSync,strFromU8} from 'fflate';
import {Engine,relativeSafe,validateProject} from '../desktop/engine.mjs';
import {template,pick,validateConnection,mediaSignature} from '../desktop/adapters.mjs';
import {splitScript,moveItem,timecode,durationOf} from '../app/domain.js';

const appDir=fileURLToPath(new URL('../app/',import.meta.url));
const png=await fs.readFile(path.join(appDir,'builtin/shot-01.png'));
const createVault=()=>{const m=new Map();return{persistent:false,has:id=>m.has(id),get:async id=>m.get(id)||'',set:async(id,v)=>m.set(id,v),delete:async id=>m.delete(id)};};
async function createEngine(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'filmdock-test-'));const engine=new Engine({root,appDir,vault:createVault()});await engine.init();return engine;}
async function settle(e,id,status='succeeded'){for(let i=0;i<400;i++){const t=e.project.tasks.find(t=>t.id===id);if(t.status===status)return t;if(['failed','submission_unknown'].includes(t.status)&&t.status!==status)throw new Error(JSON.stringify(t));await new Promise(r=>setTimeout(r,25));}throw new Error('Task did not settle');}
const base={id:'custom-api',name:'Local mock API',type:'api',outputKind:'image',model:'fixture',url:'http://127.0.0.1',headers:'{}',bodyTemplate:'{"prompt":"{{prompt}}","model":"{{model}}","duration":"{{duration}}"}',outputPath:'data.0.b64',outputFormat:'base64',tokenHeader:'Authorization',tokenPrefix:'Bearer ',async:false};
async function server(fn){const s=http.createServer(fn);await new Promise(r=>s.listen(0,'127.0.0.1',r));return{s,url:`http://127.0.0.1:${s.address().port}`,close:()=>new Promise(r=>s.close(r))};}

test('JSON templates preserve quotes, newlines and typed values without evaluating code',()=>{
 const prompt='雨夜\n"双引号" $(touch DO_NOT_CREATE) `echo hello`';
 const result=template({prompt:'{{prompt}}',duration:'{{duration}}',refs:'{{references}}'},{prompt,duration:5,references:[{role:'first_frame'}]});
 assert.equal(result.prompt,prompt);assert.equal(result.duration,5);assert.ok(Array.isArray(result.refs));
 assert.throws(()=>pick({},'__proto__.x'));assert.throws(()=>template('{{missing}}',{}));
});
test('local breakdown retains original dialogue and stable reorder',()=>{
 const shots=splitScript('内景 车站 夜\n她打开门。\n她说：“雨停了，我们就走。”');assert.equal(shots.length,2);assert.equal(shots[1].dialogue,'雨停了，我们就走。');
 assert.deepEqual(moveItem([1,2,3],0,2),[2,3,1]);assert.equal(timecode(5,24),'00:05:00');
});
test('connection validation rejects shell scripts, secret headers and incomplete polling',()=>{
 assert.throws(()=>validateConnection({...base,headers:'{"Authorization":"secret"}'}));
 assert.throws(()=>validateConnection({...base,type:'cli',program:'bad.cmd',args:'[]'}));
 assert.throws(()=>validateConnection({...base,async:true}));assert.throws(()=>validateConnection({...base,url:'file:///secret'}));
});
test('synchronous custom API performs a real local HTTP request and stores its image',async()=>{
 const e=await createEngine();let requestBody,auth,count=0;
 const srv=await server(async(req,res)=>{let raw='';for await(const b of req)raw+=b;requestBody=JSON.parse(raw);auth=req.headers.authorization;count++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{b64:png.toString('base64')}]}));});
 try{await e.saveConnections({connections:[{...base,url:srv.url,token:'PRIVATE_TOKEN'}]});const t=await e.generate({shotId:e.project.shots[0].id,kind:'image',connectionId:base.id,prompt:'雨夜"\n$(echo nothing)',acknowledged:true});await settle(e,t.id);assert.equal(count,1);assert.equal(requestBody.duration,5);assert.equal(auth,'Bearer PRIVATE_TOKEN');const m=e.project.media.find(m=>m.taskId===t.id);assert.deepEqual(await fs.readFile(e.mediaPath(m.id)),png);}finally{await srv.close();}
});
test('custom CLI uses a real child process, stdin JSON and safe argument arrays',async()=>{
 const e=await createEngine(),file=path.join(e.root,'fixture.mjs');
 await fs.writeFile(file,`import fs from 'node:fs/promises';let s='';for await(const b of process.stdin)s+=b;const j=JSON.parse(s);await fs.writeFile(j.output_directory+'/seen.json',JSON.stringify(j));await fs.copyFile(${JSON.stringify(path.join(appDir,'builtin/shot-02.png'))},j.output_directory+'/result.png');console.log(JSON.stringify({output:{path:j.output_directory+'/result.png'}}));`);
 const c={...base,id:'custom-cli',type:'cli',program:process.execPath,args:JSON.stringify([file]),outputPath:'output.path',outputFormat:'path',tokenEnv:'FILMDOCK_FIXTURE_KEY'};
 await e.saveConnections({connections:[c]});const prompt='quote "\n$(touch injected) `echo test`';const t=await e.generate({shotId:e.project.shots[0].id,kind:'image',connectionId:c.id,prompt,acknowledged:true});await settle(e,t.id);const seen=JSON.parse(await fs.readFile(path.join(e.root,'staging',t.id,'seen.json'),'utf8'));assert.equal(seen.prompt,prompt);assert.equal(e.project.media.find(m=>m.taskId===t.id).kind,'image');
});
test('async polling can resume after reload without resubmitting generation',async()=>{
 const e=await createEngine();let posts=0,ready=false;
 const srv=await server(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.method==='POST'){posts++;for await(const b of req){}res.end('{"id":"remote-one"}');}else res.end(JSON.stringify(ready?{status:'succeeded',data:[{b64:png.toString('base64')}]}:{status:'running'}));});
 try{
  const c={...base,url:srv.url,async:true,pollUrl:srv.url+'/task/{{taskId}}',taskIdPath:'id',statusPath:'status',pollInterval:1};await e.saveConnections({connections:[c]});const t=await e.generate({shotId:e.project.shots[0].id,kind:'image',connectionId:c.id,acknowledged:true});
  for(let i=0;i<100&&!e.project.tasks[0].remoteId;i++)await new Promise(r=>setTimeout(r,20));await e.pauseTask(t.id);while(e.controllers.size)await new Promise(r=>setTimeout(r,20));
  ready=true;const reloaded=new Engine({root:e.root,appDir,vault:createVault()});await reloaded.init();await reloaded.resumeTask(t.id);await settle(reloaded,t.id);assert.equal(posts,1);
 }finally{await srv.close();}
});
test('ambiguous submission is retained and will not auto resubmit',async()=>{
 const e=await createEngine();let posts=0;const srv=await server(req=>{posts++;req.socket.destroy();});
 try{await e.saveConnections({connections:[{...base,url:srv.url}]});const t=await e.generate({shotId:e.project.shots[0].id,kind:'image',connectionId:base.id,acknowledged:true});await settle(e,t.id,'submission_unknown');await assert.rejects(()=>e.resumeTask(t.id));assert.equal(posts,1);}finally{await srv.close();}
});
test('full handoff contains bytes, restores offline and omits connection secrets',async()=>{
 const e=await createEngine();await e.saveConnections({connections:[{...base,token:'TOP_SECRET_DO_NOT_EXPORT'}]});const archive=await e.exportZip(),files=unzipSync(archive);assert.ok(files['edit/cut_list.csv']);assert.ok(files['manifest.json']);assert.equal(Object.values(files).some(b=>strFromU8(b).includes('TOP_SECRET_DO_NOT_EXPORT')),false);
 const imported=await createEngine();await imported.importZip(archive);assert.equal(imported.project.shots.length,6);assert.equal(durationOf(imported.project.timeline),20);for(const m of imported.project.media){assert.deepEqual(await fs.readFile(imported.mediaPath(m.id)),Buffer.from(files[e.project.media.find(x=>x.id===m.id).path]));}
});
test('tampered handoff and escaping paths fail before replacing project',async()=>{
 const e=await createEngine(),original=e.project.id;const files=unzipSync(await e.exportZip());files['project.json'][10]^=1;await assert.rejects(()=>e.importZip(zipSync(files)),/校验失败/);assert.equal(e.project.id,original);
 for(const p of ['../escape','a/../b','C:/secret','/absolute','a\\b','a//b'])assert.throws(()=>relativeSafe(p));
 const invalid=structuredClone(e.project);invalid.timeline[0].out=1000;assert.throws(()=>validateProject(invalid));
});
test('invalid media and dimensions do not become usable output',()=>{assert.throws(()=>mediaSignature(Buffer.from('<html>failure</html>'),'image'));assert.throws(()=>mediaSignature(Buffer.alloc(0),'video'));});
test('duplicate client request IDs create only one generation task',async()=>{const e=await createEngine(),input={clientRequestId:'same-click',shotId:e.project.shots[0].id,kind:'image',connectionId:'demo'};const[a,b]=await Promise.all([e.generate(input),e.generate(input)]);assert.equal(a.id,b.id);assert.equal(e.project.tasks.length,1);await settle(e,a.id);assert.equal(e.project.media.filter(m=>m.taskId===a.id).length,1);});
test('FFmpeg rough cut preserves sequence duration within one project frame',async t=>{
 try{execFileSync('ffmpeg',['-version'],{stdio:'ignore'});}catch{t.skip('FFmpeg not installed');return;}
 const e=await createEngine();e.project.timeline=e.project.timeline.slice(0,2);e.project.timeline[0].in=.5;e.project.timeline[0].out=2.5;e.project.timeline[1].out=2;const out=path.join(e.root,'rough.mp4');await e.renderMovie(out);const info=await e.probe(out);assert.ok(Math.abs(info.duration-4)<=1/24+.005);assert.equal(info.width,1280);assert.equal(info.height,720);
});

test('Pixmax protocol gap blocks generation before creating a local or remote task',async()=>{
 const e=await createEngine();const c={id:'pixmax',provider:'pixmax',type:'cli',program:'pixmax',args:'[]',outputKind:'image'};
 await e.saveConnections({connections:[c]});const count=e.project.tasks.length;
 await assert.rejects(e.generate({shotId:e.project.shots[0].id,kind:'image',connectionId:c.id,prompt:'test',acknowledged:true}),/未提交生成/);
 assert.equal(e.project.tasks.length,count);
});
