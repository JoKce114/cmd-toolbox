import pty from 'node-pty';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = 'D:/project-demo/cmd-toolbox';
const logPath = path.join(root, '.test-data/inject.log');
const reader = path.join(root, 'tests/conpty-key-reader.ps1');
const injector = path.join(root, 'tests/conpty-inject.ps1');
const mode = process.argv[2] || 'key';

try { fs.unlinkSync(logPath); } catch {}

const p = pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', reader], {
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

p.write('a');
await new Promise((r) => setTimeout(r, 800));
console.log('sanity keys after pty write:', [...out.matchAll(/KEY #(\d+)[^\r\n]*/g)].map((m) => m[0]).join(' | ') || 'none');

const res = spawnSync('powershell.exe', [
  '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', injector,
  '-TargetPid', String(p.pid),
  '-Mode', mode,
], { cwd: root, encoding: 'utf8', timeout: 20000 });

console.log('inject exit', res.status, String(res.stderr || '').trim().slice(0, 400));
await new Promise((r) => setTimeout(r, 2000));

console.log('--- inject.log ---');
try { console.log(fs.readFileSync(logPath, 'utf8')); } catch (e) { console.log('no log', e.message); }
console.log('--- pty output (raw) ---');
console.log(JSON.stringify(out.slice(0, 1200)));
console.log('--- keys seen ---');
const keys = [...out.matchAll(/KEY #(\d+)[^\r\n]*/g)].map((m) => m[0]);
console.log(keys.length, keys.join(' | '));

try { p.kill(); } catch {}
process.exit(0);
