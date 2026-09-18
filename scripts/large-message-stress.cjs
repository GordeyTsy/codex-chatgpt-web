// Local Chromium stress test: no network, no ChatGPT service claims.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
app.whenReady().then(async()=>{
 const windows=[];const started=Date.now();const samples=[];
 try{
  const insert=fs.readFileSync(process.argv[2],'utf8');
  for(let i=0;i<2;i++){const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});windows.push(w);await w.loadURL('data:text/html,<body></body>');}
  for(let cycle=0;cycle<30;cycle++){
   const results=await Promise.all(windows.map(w=>w.webContents.executeJavaScript(`(async()=>{
    document.body.innerHTML='<div class="ProseMirror" contenteditable="true"><p><br class="ProseMirror-trailingBreak"></p></div>';
    const e=document.querySelector('div');e.focus();const text=('Тест 😀\\n').repeat(15000);
    const start=performance.now();const ok=await (${insert})(e,text);
    if(!ok||e.textContent!==text)throw Error('insertion integrity');
    return {hidden:document.hidden,units:text.length,ms:performance.now()-start};
   })()`,true)));
   samples.push({cycle,results,processes:app.getAppMetrics().map(p=>({pid:p.pid,type:p.type,rssKiB:p.memory.workingSetSize}))});
  }
  windows.forEach(w=>w.destroy());await new Promise(r=>setTimeout(r,1000));
  console.log(JSON.stringify({kind:'synthetic-hidden-stress',iterations:60,concurrency:2,durationMs:Date.now()-started,samples,after:app.getAppMetrics().map(p=>({pid:p.pid,type:p.type,rssKiB:p.memory.workingSetSize})),ok:true}));app.exit(0);
 }catch(e){console.error(e);windows.forEach(w=>{if(!w.isDestroyed())w.destroy()});app.exit(1);}
});
setTimeout(()=>{console.error('external stress timeout');app.exit(1)},180000).unref();
