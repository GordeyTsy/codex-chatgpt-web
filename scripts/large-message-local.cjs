// Synthetic Chromium regression fixture, NOT a ChatGPT end-to-end test.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
app.whenReady().then(async()=>{
 let win;
 try{
  const insertion=fs.readFileSync(process.argv.at(-2),'utf8');
  const reader=fs.readFileSync(process.argv.at(-1),'utf8');
  win=new BrowserWindow({show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  win.webContents.on('console-message',(_event,_level,message)=>console.log(message));
  await win.loadURL('data:text/html,<html><body></body></html>');
  const fixture=`(async()=>{
    try {
    const insert=${insertion};
    const read=${reader};
    function plain(node){const chunks=[],walker=document.createTreeWalker(node,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);while(walker.nextNode()){const n=walker.currentNode;if(n.nodeType===Node.TEXT_NODE)chunks.push(n.textContent);else if(n.nodeName==='BR'&&!n.classList.contains('ProseMirror-trailingBreak'))chunks.push('\\n');}return chunks.join('');}
    const results=[];
    async function check(name,text,prefix='',suffix='',nested=false){
      document.body.innerHTML='<div class="ProseMirror" style="white-space:pre-wrap" contenteditable="true"><p></p></div>';
      const e=document.querySelector('div'),p=e.firstElementChild;
      const a=document.createTextNode(prefix+suffix);
      const parent=nested?document.createElement('strong'):p;
      if(nested)p.append(parent);if(prefix+suffix)parent.append(a);else{const br=document.createElement('br');br.className='ProseMirror-trailingBreak';parent.append(br);}
      e.focus();const range=document.createRange();range.setStart(prefix+suffix?a:parent,prefix.length);range.collapse(true);
      const s=window.getSelection();s.removeAllRanges();s.addRange(range);
      let inputs=0;e.addEventListener('input',()=>inputs++);
      const t=performance.now();if(!await insert(e,text))throw Error(name+': rejected');
      const actualPlain=plain(e),actualRead=read(e),expected=prefix+text+suffix;let at=0;while(at<Math.min(actualPlain.length,expected.length)&&actualPlain[at]===expected[at])at++;if(actualPlain!==expected||actualRead!==expected.trimStart())throw Error(name+': text mismatch '+JSON.stringify({expected:expected.length,plain:actualPlain.length,read:actualRead.length,at,expectedCode:expected.codePointAt(at),observedCode:actualPlain.codePointAt(at),tail:e.innerHTML.slice(-240),rawTail:[...e.textContent.slice(-20)].map(x=>x.codePointAt(0))}));
      const r=s.getRangeAt(0),before=r.cloneRange();before.selectNodeContents(e);before.setEnd(r.startContainer,r.startOffset);
      if(plain(before.cloneContents())!==prefix+text)throw Error(name+': caret mismatch');
      if(!inputs)throw Error(name+': missing editor notification');
      const measurement={name,units:text.length,ms:performance.now()-t,hidden:document.hidden};results.push(measurement);console.log(JSON.stringify(measurement));
    }
    for(const size of [10240,102400,512000,1048576,2097152,5242880]){
      await check('lines-'+size,('Тест 😀 é 漢字\\n').repeat(Math.ceil(size/16)).slice(0,size));
      await check('one-line-'+size,'x'.repeat(size));
    }
    await check('middle-caret','Линия 😀\\n'.repeat(2000),'prefix','suffix',true);
    await check('literal-markup',('<script>neverExecute()</script> & '+String.fromCharCode(96).repeat(3)+'json\\n{\"key\":\"value\"}\\n').repeat(3000));
    document.body.innerHTML='<div class="ProseMirror" style="white-space:pre-wrap" contenteditable="true"><p><span data-id="plugin:test" data-keyword="test" contenteditable="false">Connector</span><span data-inline-selection-pill-cursor-target> </span></p><p>untouched sibling</p></div>';
    const e=document.querySelector('div'),p=e.firstElementChild;e.focus();const r=document.createRange();r.selectNodeContents(p);r.collapse(false);const s=window.getSelection();s.removeAllRanges();s.addRange(r);
    const text=' Unicode 😀\\n'.repeat(10000);await insert(e,text);
    if(e.querySelectorAll('[data-id="plugin:test"]').length!==1||e.lastElementChild.textContent!=='untouched sibling'||!plain(e.firstElementChild).endsWith(text)||read(e)!==(text+'\\nuntouched sibling').trimStart())throw Error('connector/sibling lost');
    document.body.innerHTML='<div><p>a<br>b<br class="ProseMirror-trailingBreak"></p><p></p><p>&lt;script&gt;literal&lt;/script&gt;</p></div>';
    if(read(document.querySelector('div'))!=='a\\nb\\n\\n<script>literal</script>')throw Error('hard/paragraph/trailing-break readback');
    results.push({name:'connector-and-sibling',ok:true});
    return results;
    } catch(error) { return {fixtureError:String(error)}; }
  })()`;
  new (require("node:vm").Script)(fixture,{filename:"synthetic-editor-fixture.js"});
  const results=await win.webContents.executeJavaScript(fixture,true);
  if(results.fixtureError)throw new Error(results.fixtureError);
  console.log(JSON.stringify({kind:'synthetic-dom',ok:true,results}));
  win.destroy();app.exit(0);
 }catch(error){console.error(error);if(win&&!win.isDestroyed())win.destroy();app.exit(1);}
});
setTimeout(()=>{console.error('external fixture timeout');app.exit(1);},240000).unref();
