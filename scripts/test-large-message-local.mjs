import {insertPlainTextIntoComposer,readPlainTextFromComposer} from '../src/adapters/chatgpt-web/browser-worker.ts';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const temp=mkdtempSync(join(tmpdir(),'large-message-local-'));
try {
 const source=join(temp,'insert.js');writeFileSync(source,insertPlainTextIntoComposer.toString());
 const reader=join(temp,'read.js');writeFileSync(reader,readPlainTextFromComposer.toString());
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 // Xvfb is the fixture's only display. An inherited Wayland socket or IBus
 // connection can otherwise attach this test editor to the owner's desktop.
 delete env.WAYLAND_DISPLAY;
 env.XDG_SESSION_TYPE='x11';
 env.XMODIFIERS='@im=none';
 env.GTK_IM_MODULE='none';
 env.QT_IM_MODULE='none';
 // This explicitly isolated data-URL fixture uses the same unprivileged Linux
 // Electron launch mode as the packaged AppImage. No production flags change.
 const result=spawnSync('xvfb-run',['-a',resolve('launcher/node_modules/electron/dist/electron'),'--no-sandbox','--ozone-platform=x11',resolve(process.argv.includes('--stress')?'scripts/large-message-stress.cjs':'scripts/large-message-local.cjs'),source,reader],{env,stdio:'inherit',timeout:process.argv.includes('--stress')?185000:245000});
 process.exitCode=result.status??1;
}finally{rmSync(temp,{recursive:true,force:true});}
