import pty from 'node-pty';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dir = resolve(root, '.test-data/click-inject');
const log = resolve(dir, 'mouse-reader.log');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const helper = resolve(root, 'build/coninject.exe');
let passed = 0;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

function assert(condition, message, detail) {
  if (!condition) throw new Error(`断言失败：${message} ${detail ?? ''}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

function inject(line) {
  const result = spawnSync(helper, [], { input: `${line}\n`, encoding: 'utf8', timeout: 10000 });
  return String(result.stdout).trim();
}

const env = { ...process.env, TERM: 'xterm-256color' };

let cmd;
let reader;
let ps;
try {
  console.log('1. 普通 CMD 没有鼠标输入模式');
  cmd = pty.spawn('cmd.exe', [], { name: 'xterm-256color', cols: 100, rows: 30, cwd: root, env });
  await wait(1500);
  const cmdResult = inject(`click ${cmd.pid} 10 10`);
  console.log('  helper:', cmdResult);
  assert(cmdResult.startsWith('skip nomouse'), 'CMD 控制台点击被跳过', cmdResult);

  console.log('2. 普通 PowerShell 控制台模式');
  ps = pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile'], { name: 'xterm-256color', cols: 100, rows: 30, cwd: root, env });
  await wait(2500);
  const psResult = inject(`click ${ps.pid} 10 10`);
  console.log('  helper:', psResult);

  console.log('3. 启用鼠标输入的 TUI 收到按下、抬起');
  reader = pty.spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(root, 'tests/console-mouse-reader.ps1'), '-Seconds', '8', '-Log', log],
    { name: 'xterm-256color', cols: 80, rows: 24, cwd: root, env },
  );
  await wait(2500);
  const readerResult = inject(`click ${reader.pid} 10 10`);
  console.log('  helper:', readerResult);
  assert(readerResult === 'ok', '鼠标输入开启时点击写入成功', readerResult);
  await wait(700);

  const content = readFileSync(log, 'utf8');
  const move = content.indexOf('flags=1');
  const down = content.indexOf('state=0x00000001');
  const up = content.indexOf('state=0x00000000', down);
  assert(move >= 0 && down > move && up > down, '收到移动、左键按下、左键抬起三条记录', JSON.stringify(content));

  console.log(`\n${passed} 项断言通过`);
} finally {
  try {
    cmd?.kill();
  } catch {}
  try {
    ps?.kill();
  } catch {}
  try {
    reader?.kill();
  } catch {}
  await wait(300);
  rmSync(dir, { recursive: true, force: true });
}
