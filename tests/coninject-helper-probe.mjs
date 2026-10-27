import pty from 'node-pty';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = 'D:/project-demo/cmd-toolbox';
const mouseLog = path.join(root, '.test-data/mouse-reader.log');
const helper = path.join(root, 'build/coninject.exe');

try { fs.unlinkSync(mouseLog); } catch {}

const reader = pty.spawn('powershell.exe', [
  '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', path.join(root, 'tests/console-mouse-reader.ps1'),
  '-Seconds', '6',
], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: root,
  env: { ...process.env },
});

await new Promise((r) => setTimeout(r, 2000));
console.log('pty pid', reader.pid);

const child = spawn(helper, [], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
child.stdin.write(`wheel ${reader.pid} 120 10 10\n`);
await new Promise((r) => setTimeout(r, 500));
child.stdin.write(`wheel ${reader.pid} -120 10 10\n`);
await new Promise((r) => setTimeout(r, 500));

console.log('helper alive', child.exitCode === null, 'out', JSON.stringify(out));

await new Promise((r) => setTimeout(r, 5000));
console.log('--- mouse log ---');
try { console.log(fs.readFileSync(mouseLog, 'utf8')); } catch (e) { console.log('no log', e.message); }

child.stdin.end();
await new Promise((r) => setTimeout(r, 500));
console.log('helper exit after stdin close:', child.exitCode);
try { reader.kill(); } catch {}
process.exit(0);
