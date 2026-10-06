// Native, sandboxed macOS runner for the existing synthetic Chromium fixtures.
// This sends no ChatGPT messages and is not an authenticated end-to-end test.
import { insertPlainTextIntoComposer, readPlainTextFromComposer } from '../src/adapters/chatgpt-web/browser-worker.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
if (process.platform !== 'darwin') throw new Error('This runner requires macOS');
const temp = mkdtempSync(join(tmpdir(), 'codex-macos-fixture-'));
try {
  const source = join(temp, 'insert.js'), reader = join(temp, 'read.js');
  writeFileSync(source, insertPlainTextIntoComposer.toString());
  writeFileSync(reader, readPlainTextFromComposer.toString());
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const stress = process.argv.includes('--stress');
  const result = spawnSync(resolve('launcher/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [
    resolve(stress ? 'scripts/large-message-stress.cjs' : 'scripts/large-message-local.cjs'), source, reader,
  ], { env, stdio: 'inherit', timeout: stress ? 185000 : 245000 });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
