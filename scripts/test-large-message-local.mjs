import {insertPlainTextIntoComposer} from '../src/adapters/chatgpt-web/browser-worker.ts';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const temp=mkdtempSync(join(tmpdir(),'large-message-local-'));
try {
 const source=join(temp,'insert.js');writeFileSync(source,insertPlainTextIntoComposer.toString());
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const result=spawnSync('xvfb-run',['-a',resolve('launcher/node_modules/electron/dist/electron'),resolve(process.argv.includes('--stress')?'scripts/large-message-stress.cjs':'scripts/large-message-local.cjs'),source],{env,stdio:'inherit',timeout:process.argv.includes('--stress')?185000:65000});
 process.exitCode=result.status??1;
}finally{rmSync(temp,{recursive:true,force:true});}
