// 验证：直接向 ConPTY 写入 0x16 是否能被控制台程序识别为 Ctrl+V 按键
const pty = require('D:/deskTop/CmdToolbox/cmd-toolbox/node_modules/node-pty');
const fs = require('fs');
const os = require('os');
const path = require('path');

const log = path.join(os.tmpdir(), `keylog2-${Date.now()}.txt`);
const reader = 'D:/deskTop/CmdToolbox/cmd-toolbox/tests/console-key-reader-file.ps1';

const p = pty.spawn(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', reader, '-Log', log],
  { cols: 100, rows: 30, useConpty: true },
);
p.onData(() => {});

setTimeout(() => {
  console.log('写入 \\x16 (Ctrl+V 控制字符)');
  p.write('\x16');
}, 2500);

setTimeout(() => {
  const text = fs.readFileSync(log, 'utf8');
  console.log('--- log ---');
  console.log(text.trim());
  try { p.kill(); } catch {}
  process.exit(0);
}, 4500);
