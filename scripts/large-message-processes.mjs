import {readdirSync,readFileSync} from 'node:fs';
/** Linux process-tree samples; sums are RSS, not unique physical memory. No argv or env. */
export function processTree(rootPid) {
 const rows=[];
 for(const name of readdirSync('/proc')){
  if(!/^\d+$/.test(name))continue;
  try{
   const raw=readFileSync(`/proc/${name}/stat`,'utf8');const end=raw.lastIndexOf(')');const f=raw.slice(end+2).trim().split(/\s+/);
   rows.push({pid:Number(name),ppid:Number(f[1]),name:raw.slice(raw.indexOf('(')+1,end),cpuTicks:Number(f[11])+Number(f[12]),rssKiB:Number(f[21])*4,startTicks:Number(f[19])});
  }catch{}
 }
 const ids=new Set([rootPid]);let changed=true;while(changed){changed=false;for(const row of rows)if(ids.has(row.ppid)&&!ids.has(row.pid)){ids.add(row.pid);changed=true;}}
 const processes=rows.filter(r=>ids.has(r.pid));return{processes,rssKiB:processes.reduce((n,r)=>n+r.rssKiB,0),count:processes.length};
}
