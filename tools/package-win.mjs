import {fileURLToPath} from 'node:url';
import {packager} from '@electron/packager';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const version=pkg.devDependencies.electron.replace(/^[^\d]+/,'');
const result=await packager({dir:root,out:path.join(root,'release'),name:'FilmDock',executableName:'FilmDock',icon:path.join(root,'app/icon.ico'),appVersion:'0.2.0',electronVersion:version,platform:'win32',arch:'x64',overwrite:true,asar:true,prune:true,ignore:[/^\/release/,/^\/tests/,/^\/tools/,/^\/test-results/,/^\/docs/,/^\/\.git/,/^\/package-lock\.json$/],win32metadata:{ProductName:'FilmDock Demo',FileDescription:'AI filmmaking desktop demo',CompanyName:'FilmDock'}});
console.log(result.join('\n'));
