// 纯 Node 验证：不启动 Electron，直接检查纯逻辑部分
import assert from 'node:assert';

let passed = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  passed += 1;
  console.log('  ok  ' + msg);
};

console.log('1. 自然排序（与 FileTree 同一套比较器）');
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const compareEntries = (a, b) => {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return collator.compare(a.name, b.name);
};
const files = ['101.txt', '2.txt', '10.txt', '1.txt', '200.txt', '20.txt'].map((name) => ({
  name,
  isDir: false,
}));
const sorted = [...files].sort(compareEntries).map((f) => f.name);
console.log('   排序结果:', JSON.stringify(sorted));
ok(
  JSON.stringify(sorted) === JSON.stringify(['1.txt', '2.txt', '10.txt', '20.txt', '101.txt', '200.txt']),
  '数字按数值排序',
);

const withDirs = [
  { name: 'a.txt', isDir: false },
  { name: 'zdir', isDir: true },
  { name: '1.txt', isDir: false },
  { name: 'adir', isDir: true },
].sort(compareEntries);
ok(withDirs[0].isDir && withDirs[1].isDir, '目录排在最前');
ok(withDirs[2].name === '1.txt', '目录之后按名称排序');

console.log('2. 键位组合规范化');
const normalizeCombo = (combo) =>
  combo
    .split('-')
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === 'ctrl' || lower === 'control') return 'Ctrl';
      if (lower === 'alt') return 'Alt';
      if (lower === 'shift') return 'Shift';
      if (lower === 'meta' || lower === 'cmd') return 'Meta';
      if (lower.startsWith('arrow')) {
        const direction = lower.slice(5);
        return `Arrow${direction.charAt(0).toUpperCase()}${direction.slice(1)}`;
      }
      if (lower.length === 1) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('-');
ok(normalizeCombo('ctrl-shift-k') === 'Ctrl-Shift-k', '小写输入规范化为标准写法');
ok(normalizeCombo('Ctrl-Alt-ArrowDown') === 'Ctrl-Alt-ArrowDown', '方向键保持驼峰');
ok(normalizeCombo('shift-tab') === 'Shift-Tab', 'Tab 组合正确');

console.log('3. 冲突检测规则');
const RESERVED = ['Ctrl-s', 'Ctrl-w', 'Ctrl-f', 'Ctrl-Shift-f', 'Ctrl-t'];
const isReserved = (combo) => RESERVED.some((r) => normalizeCombo(r) === normalizeCombo(combo));
ok(isReserved('ctrl-s'), 'Ctrl+S 被识别为保留键');
ok(isReserved('Ctrl-Shift-f'), 'Ctrl+Shift+F 被识别为保留键');
ok(!isReserved('Ctrl-g'), 'Ctrl+G 可自由绑定');

const DEFAULT_KEYBINDINGS = {
  indent: 'Tab',
  outdent: 'Shift-Tab',
  copyLineDown: 'Shift-Alt-ArrowDown',
  copyLineUp: 'Shift-Alt-ArrowUp',
  moveLineUp: 'Alt-ArrowUp',
  moveLineDown: 'Alt-ArrowDown',
  deleteLine: 'Ctrl-Shift-k',
  toggleComment: 'Ctrl-/',
  toggleBlockComment: 'Ctrl-Shift-/',
  gotoLine: 'Ctrl-g',
};
const values = Object.values(DEFAULT_KEYBINDINGS).map(normalizeCombo);
ok(new Set(values).size === values.length, '默认键位之间没有重复');
ok(values.every((v) => !isReserved(v)), '默认键位不占用应用级快捷键');
ok(Object.keys(DEFAULT_KEYBINDINGS).length === 10, '共 10 个可配置动作');

console.log('4. 祖先路径展开（文件树自动定位）');
const ancestorsOf = (relPath) => {
  const parts = relPath.split('/');
  parts.pop();
  const result = [''];
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    result.push(current);
  }
  return result;
};
ok(
  JSON.stringify(ancestorsOf('a/b/c.txt')) === JSON.stringify(['', 'a', 'a/b']),
  '深层路径的祖先目录正确',
);
ok(JSON.stringify(ancestorsOf('x.txt')) === JSON.stringify(['']), '顶层文件只返回根');

console.log(`\n全部通过：${passed} 项`);
