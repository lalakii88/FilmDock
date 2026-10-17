import {fileURLToPath} from 'node:url';
import {_electron as electron} from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url));
await fs.rm(path.join(root,'test-results/browser-config'),{recursive:true,force:true});
process.env.PORT='4179';const {server:previewServer}=await import('./serve.mjs');
const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron'),args:['--no-sandbox','--disable-gpu','--ozone-platform=headless',root],env:{...process.env,FILMDOCK_TEST_MODE:'1',XDG_CONFIG_HOME:path.join(root,'test-results/browser-config')}});
try{
 await app.firstWindow();
 const pending=app.waitForEvent('window');await app.evaluate(async({BrowserWindow})=>{const w=new BrowserWindow({width:1600,height:1000,minWidth:1120,minHeight:740,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});await w.loadURL('http://127.0.0.1:4179');w.show();});
 const page=await pending;await page.setViewportSize({width:1600,height:1000});await page.bringToFront();await page.waitForSelector('.shot-card');assert.ok((await page.locator('.statusbar').textContent()).includes('浏览器预览'));assert.equal(await page.locator('.shot-card').count(),6);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.locator('[data-action="generate-image"]').click();await page.locator('#generation-form button[type="submit"]').click();await page.waitForFunction(()=>document.querySelector('#toasts')?.textContent.includes('已入库'));await page.waitForTimeout(700);
 const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('filmdock-project')));assert.equal(stored.media.length,11);await page.reload();await page.waitForSelector('.shot-card');const restored=await page.evaluate(()=>JSON.parse(localStorage.getItem('filmdock-project')));assert.equal(restored.media.length,11);assert.deepEqual(errors,[]);console.log('PASS: browser fallback, local demo generation, localStorage persistence and reload.');
}finally{await app.close();await new Promise(r=>previewServer.close(r));}
