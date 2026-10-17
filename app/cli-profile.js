import {unzipSync,strFromU8} from './vendor/fflate.js';

// Portfolio import inspects metadata only; it never installs or executes the CLI.
export function inspectCliPackage(bytes,filename='pixmax-cli.zip') {
  if(bytes.length>100*1024*1024)throw new Error('请选择100MB以内的 CLI ZIP 包');
  let total=0;const names=[];
  const files=unzipSync(bytes,{filter:e=>{
    const parts=e.name.split('/');
    if(e.name.includes('\\')||e.name.includes(':')||e.name.startsWith('/')||parts.some(p=>p==='.'||p==='..'))throw new Error('CLI 包含不安全路径');
    total+=e.originalSize;if(total>200*1024*1024)throw new Error('CLI 包解压后过大');
    names.push(e.name);
    return e.originalSize<=128*1024&&/(^|\/)(setup\.py|pixmax\/__init__\.py|release\/manifest\.json)$/.test(e.name);
  }});
  const root=names.find(n=>/(^|\/)setup\.py$/.test(n))?.replace(/setup\.py$/,'');
  if(root===undefined||!names.includes(root+'pixmax/__main__.py')||!names.includes(root+'release/runtime.zip'))throw new Error('未识别为 Pixmax CLI 技能包，请选择包含 setup.py 与 release/runtime.zip 的 ZIP');
  let version='';
  const init=files[root+'pixmax/__init__.py'];
  if(init)version=strFromU8(init).match(/__version__\s*=\s*['"]([^'"]+)['"]/)?.[1]||'';
  return {provider:'pixmax',presentation:true,packageImported:true,packageName:filename,packageVersion:version,program:'pixmax',args:'[]',model:'',pixmaxStatus:null};
}

export function presentationStatus(c) {
  const imported=c.packageImported===true||c.cliSelected===true;
  const kind=c.outputKind==='video'?'video':'image';
  const model={code:'demo-pixmax-'+kind,name:kind==='video'?'视频生成 · 演示模型':'图像生成 · 演示模型'};
  return {demonstration:true,installed:imported,ready:imported,models:imported?[model]:[],model:imported?model.code:'',checkedAt:new Date().toISOString(),message:imported?'演示连接已就绪，可体验生成与素材入库流程。':'请先导入 CLI ZIP 包或选择本机 CLI 文件。'};
}
