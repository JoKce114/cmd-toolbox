import pty from 'node-pty';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = 'D:/project-demo/cmd-toolbox';
const injectLog = path.join(root, '.test-data/inject.log');
const mouseLog = path.join(root, '.test-data/mouse-reader.log');
const reader = path.join(root, 'tests/console-mouse-reader.ps1');
const injector = path.join(root, 'tests/conpty-inject.ps1');
const mode = process.argv[2] || 'mouse';
const delta = process.argv[3] || '120';

for (const file of [injectLog, mouseLog]) { try { fs.unlinkSync(file); } catch {} }

const p = pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', reader, '-Seconds', '5'], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: root,
  env: { ...process.env },
});

let out = '';
p.onData((d) => { out += d; });

await new Promise((r) => setTimeout(r, 2500));
console.log('pty pid', p.pid);

for (let i = 0; i < 3; i += 1) {
  const res = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', injector,
    '-TargetPid', String(p.pid),
    '-Mode', mode,
    '-Delta', delta,
  ], { cwd: root, encoding: 'utf8', timeout: 20000 });
  if (res.status !== 0) console.log('inject fail', res.status, String(res.stderr || '').slice(0, 300));
  await new Promise((r) => setTimeout(r, 400));
}

await new Promise((r) => setTimeout(r, 8000));

console.log('--- inject.log ---');
try { console.log(fs.readFileSync(injectLog, 'utf8')); } catch (e) { console.log('no inject log', e.message); }
console.log('--- mouse.log ---');
try { console.log(fs.readFileSync(mouseLog, 'utf8')); } catch (e) { console.log('no mouse log', e.message); }
console.log('--- pty tail ---');
console.log(JSON.stringify(out.slice(-600)));

try { p.kill(); } catch {}
process.exit(0);
