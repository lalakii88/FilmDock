const {contextBridge,ipcRenderer}=require('electron');
const methods=['bootstrap','saveProject','saveConnections','checkConnection','newProject','resetDemo','generate','resumeTask','pauseTask','importMedia','importScript','exportPackage','openProject','renderMovie','importPixmax','chooseProgram','window'];
const api=Object.fromEntries(methods.map(name=>[name,arg=>ipcRenderer.invoke('filmdock:'+name,arg)]));
api.onEvent=fn=>{const listener=(_event,data)=>fn(data);ipcRenderer.on('filmdock:event',listener);return()=>ipcRenderer.removeListener('filmdock:event',listener);};
contextBridge.exposeInMainWorld('filmdock',api);
