const {app,BrowserWindow,ipcMain,dialog,protocol,net,safeStorage,Menu}=require('electron');
const path=require('node:path');
const fs=require('node:fs/promises');
const {pathToFileURL}=require('node:url');

if(process.env.FILMDOCK_TEST_MODE==='1'&&process.env.FILMDOCK_TEST_USER_DATA)app.setPath('userData',process.env.FILMDOCK_TEST_USER_DATA);
protocol.registerSchemesAsPrivileged([{scheme:'filmdock',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
if(process.env.FILMDOCK_TEST_MODE!=='1'&&!app.requestSingleInstanceLock())app.quit();
let win,engine,rendering=false;
const handlers=new Map();
const appDir=path.resolve(__dirname,'../app');
function handle(name,fn){handlers.set(name,fn);ipcMain.handle('filmdock:'+name,async(event,arg)=>{if(!event.senderFrame?.url.startsWith('filmdock://app/'))throw new Error('无效调用来源');try{return await fn(arg);}catch(e){throw new Error(e.message||'操作失败');}});}
app.on('second-instance',()=>{if(win){win.show();win.focus();}});
app.whenReady().then(async()=>{
 const {Engine}=await import('./engine.mjs');
 const root=path.join(app.getPath('userData'),'workspace');await fs.mkdir(root,{recursive:true});
 const vaultFile=path.join(app.getPath('userData'),'credentials.enc.json');let encrypted={};const session=new Map();
 try{encrypted=JSON.parse(await fs.readFile(vaultFile,'utf8'));}catch{}
 const available=safeStorage.isEncryptionAvailable()&&!(process.platform==='linux'&&safeStorage.getSelectedStorageBackend()==='basic_text');
 const writeVault=()=>fs.writeFile(vaultFile,JSON.stringify(encrypted));
 const vault={persistent:available,has:id=>session.has(id)||!!encrypted[id],get:async id=>{if(session.has(id))return session.get(id);if(encrypted[id]&&available){try{return safeStorage.decryptString(Buffer.from(encrypted[id],'base64'));}catch{throw new Error('本机密钥无法解密，请重新填写连接密钥');}}return'';},set:async(id,value)=>{session.set(id,value);if(available){encrypted[id]=safeStorage.encryptString(value).toString('base64');await writeVault();}},delete:async id=>{session.delete(id);delete encrypted[id];await writeVault();}};
 engine=new Engine({root,appDir,vault,onEvent:event=>win?.webContents.send('filmdock:event',event)});await engine.init();
 protocol.handle('filmdock',async request=>{
  try{const u=new URL(request.url);let file;
   if(u.hostname==='media'){file=engine.mediaPath(decodeURIComponent(u.pathname.slice(1)));}
   else if(u.hostname==='app'){const rel=decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname);file=path.resolve(appDir,'.'+rel);if(!file.startsWith(appDir+path.sep))return new Response('Forbidden',{status:403});}
   else return new Response('Not found',{status:404});
   return net.fetch(pathToFileURL(file).toString());
  }catch{return new Response('Not found',{status:404});}
 });
 handle('bootstrap',()=>engine.bootstrap());handle('saveProject',p=>engine.saveProject(p));
 handle('saveConnections',x=>engine.saveConnections(x));handle('checkConnection',id=>engine.checkConnection(id));
 handle('newProject',title=>{if(rendering)throw new Error('请等待粗剪导出结束后再切换项目');return engine.newProject(title);});handle('resetDemo',()=>{if(rendering)throw new Error('请等待粗剪导出结束后再切换项目');return engine.resetDemo();});
 handle('generate',x=>engine.generate(x));handle('resumeTask',id=>engine.resumeTask(id));handle('pauseTask',id=>engine.pauseTask(id));
 handle('importMedia',async target=>{const choice=await dialog.showOpenDialog(win,{title:'导入图片或视频',properties:['openFile','multiSelections'],filters:[{name:'图片与视频',extensions:['png','jpg','jpeg','webp','gif','mp4','webm']}]});if(choice.canceled)return[];const media=[];for(const file of choice.filePaths){const s=await fs.stat(file);if(s.size>100*1024*1024)throw new Error('单文件不能超过100MB');media.push(await engine.importBytes({name:path.basename(file),bytes:await fs.readFile(file),...target}));}return media;});
 handle('importScript',async()=>{const choice=await dialog.showOpenDialog(win,{title:'导入文本剧本',properties:['openFile'],filters:[{name:'文本剧本',extensions:['txt','md']}]});if(choice.canceled)return null;const stat=await fs.stat(choice.filePaths[0]);if(stat.size>2*1024*1024)throw new Error('剧本文本不能超过2MB');return fs.readFile(choice.filePaths[0],'utf8');});
 handle('exportPackage',async()=>{const choice=await dialog.showSaveDialog(win,{title:'导出项目交接包',defaultPath:engine.project.title+'-FilmDock.zip',filters:[{name:'项目交接包',extensions:['zip']}]});if(choice.canceled)return null;const bytes=await engine.exportZip();await fs.writeFile(choice.filePath+'.tmp',bytes);await fs.rename(choice.filePath+'.tmp',choice.filePath);return{file:choice.filePath};});
 handle('openProject',async()=>{if(rendering)throw new Error('请等待粗剪导出结束后再切换项目');engine.assertIdle();const choice=await dialog.showOpenDialog(win,{title:'打开FilmDock交接包',properties:['openFile'],filters:[{name:'FilmDock项目包',extensions:['zip']}]});if(choice.canceled)return null;const stat=await fs.stat(choice.filePaths[0]);if(stat.size>100*1024*1024)throw new Error('ZIP超过Demo的100MB限制');return engine.importZip(await fs.readFile(choice.filePaths[0]));});
 handle('renderMovie',async()=>{if(rendering)throw new Error('已有导出任务正在执行');const choice=await dialog.showSaveDialog(win,{title:'导出MP4粗剪',defaultPath:engine.project.title+'-粗剪.mp4',filters:[{name:'MP4',extensions:['mp4']}]});if(choice.canceled)return null;rendering=true;try{return await engine.renderMovie(choice.filePath);}finally{rendering=false;}});
 handle('importPixmax',async()=>{const choice=await dialog.showOpenDialog(win,{title:'选择 Pixmax CLI 技能 ZIP 包',properties:['openFile'],filters:[{name:'Pixmax CLI 包',extensions:['zip']}]});if(choice.canceled)return null;const stat=await fs.stat(choice.filePaths[0]);if(stat.size>100*1024*1024)throw new Error('CLI包超过100MB');const {inspectCliPackage}=await import('../app/cli-profile.js');return inspectCliPackage(await fs.readFile(choice.filePaths[0]),path.basename(choice.filePaths[0]));});
 handle('chooseProgram',async()=>{const choice=await dialog.showOpenDialog(win,{title:'选择程序文件',properties:['openFile']});return choice.canceled?null:choice.filePaths[0];});
 handle('window',action=>{if(action==='minimize')win.minimize();else if(action==='maximize'){win.isMaximized()?win.unmaximize():win.maximize();}else if(action==='close')win.close();});
 win=new BrowserWindow({width:1560,height:1000,minWidth:1120,minHeight:740,backgroundColor:'#111214',title:'FilmDock',icon:path.join(appDir,'icon.png'),frame:false,show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,spellcheck:false}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(e,url)=>{if(!url.startsWith('filmdock://app/'))e.preventDefault();});
 Menu.setApplicationMenu(null);await win.loadURL('filmdock://app/index.html');if(process.env.FILMDOCK_TEST_MODE==='1'&&process.env.FILMDOCK_SMOKE_REPORT){await fs.writeFile(process.env.FILMDOCK_SMOKE_REPORT,JSON.stringify({loaded:true,title:win.getTitle(),url:win.webContents.getURL(),version:app.getVersion()}));app.quit();return;}win.show();
 win.on('close',e=>{if(engine.controllers.size||rendering){const choice=dialog.showMessageBoxSync(win,{type:'question',buttons:['继续制作','退出客户端'],defaultId:0,cancelId:0,message:'仍有任务正在运行',detail:'退出会停止本地处理；已经提交的云端任务可能继续并产生费用。'});if(choice===0)e.preventDefault();}});
});
app.on('window-all-closed',()=>app.quit());
