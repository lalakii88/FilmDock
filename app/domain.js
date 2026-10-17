export const uid=()=>crypto.randomUUID();
export const clone=value=>structuredClone(value);
export const durationOf=timeline=>timeline.reduce((n,c)=>n+c.out-c.in,0);
export function timecode(seconds,fps=24){const f=Math.max(0,Math.round(seconds*fps));return`${String(Math.floor(f/fps/60)).padStart(2,'0')}:${String(Math.floor(f/fps)%60).padStart(2,'0')}:${String(f%fps).padStart(2,'0')}`;}
export function moveItem(items,from,to){const a=[...items];if(from<0||to<0||from>=a.length||to>=a.length)return a;const[v]=a.splice(from,1);a.splice(to,0,v);return a;}
export function splitScript(script){
 const lines=script.split(/\n+/).map(l=>l.trim()).filter(Boolean).filter(l=>!/^((内|外)景|SC\d|第.{1,5}[集场])/i.test(l));
 const parts=lines.length>1?lines:script.split(/(?<=[。！？])/).map(s=>s.trim()).filter(Boolean);
 return parts.slice(0,30).map((description,i)=>{const dialogue=description.match(/[“「](.*?)[”」]/)?.[1]||'';return{id:uid(),code:`SH ${String(i+1).padStart(3,'0')}`,title:description.replace(/[“”]/g,'').slice(0,12),description,duration:5,size:i===0?'远景':'中景',angle:'人物侧前方机位',camera:'固定镜头',dialogue,prompt:description+'。动作连续，人物与场景参考保持一致。无字幕、无配乐、无水印。',assetIds:[],keyframeId:null,videoId:null,status:'draft'};});
}
export function cutList(project){let at=0;return project.timeline.map(c=>{const r={...c,start:at,duration:c.out-c.in};at+=r.duration;return r;});}
