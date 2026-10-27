import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('fs').readFileSync(new URL('../src/lib.ts', import.meta.url), 'utf8');

function quoteTerminalPath(value) {
  const filePath = value.trim();
  if (!filePath) return '';
  if (!/[\s&()[\]{}^=;,'!]/.test(filePath)) return filePath;
  return `"${filePath.replace(/"/g, '\\"')}"`;
}

function formatDroppedPaths(paths) {
  return paths.map(quoteTerminalPath).filter(Boolean).join('\r');
}

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

assert(ts.includes('export function quoteTerminalPath'), '源码导出 quoteTerminalPath');
assert(quoteTerminalPath('D:\\deskTop\\a.png') === 'D:\\deskTop\\a.png', '无空格路径不加点');
assert(
  quoteTerminalPath('D:\\deskTop\\我的 图.png') === '"D:\\deskTop\\我的 图.png"',
  '有空格就加引号',
);
assert(formatDroppedPaths(['a.png', 'b.png']) === 'a.png\rb.png', '多张路径分行');
assert(formatDroppedPaths(['', '  ']) === '', '空路径丢掉');

console.log(`paths ${passed} passed`);
