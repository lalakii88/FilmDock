import {fileURLToPath} from 'node:url';
import {_electron as electron} from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import http from 'node:http';
const root=fileURLToPath(new URL('../',import.meta.url));
const results=path.join(root,'test-results/e2e');await fs.mkdir(results,{recursive:true});
await fs.rm(path.join(results,'config'),{recursive:true,force:true});
const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox','--disable-gpu','--ozone-platform=headless',root],env:{...process.env,FILMDOCK_TEST_MODE:'1',XDG_CONFIG_HOME:path.join(results,'config')},timeout:30000});
let server;let requests=0;const errors=[];
try{
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1600,height:1000});await page.waitForSelector('.shot-card');
 assert.equal(await page.locator('.shot-card').count(),6);await page.screenshot({path:path.join(results,'01-board.png')});
 const click=action=>page.locator(`[data-action="${action}"]`).first().click();
 const route=id=>page.locator(`.sidebar [data-route="${id}"]`).click();
 await route('script');assert.ok((await page.locator('.script-editor').inputValue()).includes('雨停了，我们就走。'));await page.screenshot({path:path.join(results,'02-script.png')});
 await route('assets');assert.equal(await page.locator('.asset-card').count(),4);await click('new-asset');await page.locator('#asset-form [name="name"]').fill('测试道具');await page.locator('#asset-form [name="description"]').fill('一盏旧站台灯');await page.locator('#asset-form button[type="submit"]').click();assert.equal(await page.locator('.asset-card').count(),5);
 await route('board');await page.locator('[data-action="select-shot"][data-id="shot-5"]').click();await click('generate-video');await page.locator('#generation-form button[type="submit"]').click();
 async function waitTasks(predicate){const limit=Date.now()+20000;while(Date.now()<limit){const b=await page.evaluate(()=>window.filmdock.bootstrap());if(predicate(b.project.tasks))return;await new Promise(r=>setTimeout(r,30));}throw new Error('UI task did not complete');}
 await waitTasks(tasks=>tasks.some(t=>t.status==='succeeded'&&t.shotId==='shot-5'));
 await route('media');await page.locator('.media-card').filter({hasText:'最后一格暖光 · 视频 · 演示'}).locator('[data-action="adopt"]').click();
 await route('edit');await click('autofill');await click('confirm-autofill');assert.equal(await page.locator('.timeline-clip').count(),5);
 await page.locator('[data-trim="in"]').fill('0.5');await page.locator('[data-trim="in"]').press('Tab');assert.equal(await page.locator('[data-trim="in"]').inputValue(),'0.5');await click('undo');assert.equal(await page.locator('[data-trim="in"]').inputValue(),'0');
 await page.screenshot({path:path.join(results,'03-edit.png')});await click('toggle-play');await page.waitForTimeout(600);const current=await page.locator('#timeline-player').evaluate(v=>v.currentTime);assert.ok(current>0);await click('toggle-play');
 await route('connections');await click('add-api');await page.locator('[data-bind="connection.name"]').fill('本地HTTP验证');
 const png=await fs.readFile(path.join(root,'app/builtin/shot-06.png'));
 server=http.createServer(async(req,res)=>{requests++;for await(const b of req){}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{url:'data:image/png;base64,'+png.toString('base64')}]}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await page.locator('[data-bind="connection.url"]').fill(`http://127.0.0.1:${server.address().port}/images`);await page.locator('[data-bind="connection.model"]').fill('local-fixture');await page.locator('[data-bind="connection.token"]').fill('LOCAL_ONLY_TEST_KEY');await click('save-connection');await page.screenshot({path:path.join(results,'04-connections.png')});
 await route('board');await click('generate-image');await page.locator('#generation-form [name="connection"]').selectOption({label:'本地HTTP验证 · API'});await page.locator('#generation-form [name="acknowledged"]').check();await page.locator('#generation-form button[type="submit"]').click();
 await waitTasks(tasks=>tasks.some(t=>!t.demo&&t.status==='succeeded'));assert.equal(requests,1);
 const zip=path.join(results,'roundtrip.zip');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},zip);await click('handoff');await page.screenshot({path:path.join(results,'05-handoff.png')});await click('export-package');await page.waitForFunction(()=>!document.querySelector('.modal'),{},{timeout:20000});assert.ok((await fs.stat(zip)).size>1000000);
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},zip);await click('project-menu');await click('open-project');await page.waitForFunction(()=>!document.querySelector('.modal'),{},{timeout:20000});
 const p=await page.evaluate(async()=>(await window.filmdock.bootstrap()).project);assert.equal(p.timeline.length,5);assert.equal(p.assets.length,5);assert.ok(p.media.length>=12);
 await route('edit');const video=path.join(results,'ui-rough-cut.mp4');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},video);await click('render-movie');await page.waitForFunction(()=>document.querySelector('[data-action="render-movie"]')?.textContent.includes('导出 MP4'),{},{timeout:60000});assert.ok((await fs.stat(video)).size>10000);
 assert.deepEqual(errors,[]);console.log('PASS: Electron UI navigation, asset creation, demo video generation, adoption, timeline, playback, trim/undo, custom HTTP API, ZIP roundtrip, MP4 export.');
 await fs.writeFile(path.join(results,'result.json'),JSON.stringify({pass:true,errors,apiRequests:requests,shots:p.shots.length,media:p.media.length,timelineClips:p.timeline.length},null,2));
}finally{if(server)await new Promise(r=>server.close(r));await app.close();}
