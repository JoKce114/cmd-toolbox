// 空白窗口的虚拟路径：判断、编号分配、显示名。纯函数，离线可跑。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
void require;

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error('断言失败：' + message);
  passed += 1;
  console.log('  ok  ' + message);
}

const mod = await import('../src/untitledPath.ts');

console.log('1. isUntitledPath');
assert(mod.isUntitledPath('untitled://1') === true, '虚拟路径被识别');
assert(mod.isUntitledPath('untitled://42') === true, '多位数编号也识别');
assert(mod.isUntitledPath('app/a.php') === false, '普通路径不是虚拟路径');
assert(mod.isUntitledPath('') === false, '空字符串不是虚拟路径');
assert(mod.isUntitledPath('untitled:/x') === false, '少一个斜杠不算（前缀严格匹配）');

console.log('2. untitledPathFor');
assert(mod.untitledPathFor(1) === 'untitled://1', '编号 1 拼出正确路径');
assert(mod.untitledPathFor(12) === 'untitled://12', '两位数编号');

console.log('3. nextUntitledIndex 复用最小可用值');
assert(mod.nextUntitledIndex([]) === 1, '空列表返回 1');
assert(mod.nextUntitledIndex(['untitled://1']) === 2, '已有 1 返回 2');
assert(mod.nextUntitledIndex(['untitled://2']) === 1, '缺 1 时返回 1');
assert(mod.nextUntitledIndex(['untitled://1', 'untitled://3']) === 2, '复用中间空缺的 2');
assert(
  mod.nextUntitledIndex(['untitled://1', 'untitled://2', 'untitled://3']) === 4,
  '连续时返回下一个',
);
assert(
  mod.nextUntitledIndex(['app/a.php', 'untitled://2']) === 1,
  '普通路径不参与编号计算',
);

console.log('4. displayNameFor');
assert(mod.displayNameFor('untitled://1') === 'Untitled-1', '虚拟路径显示为 Untitled-1');
assert(mod.displayNameFor('untitled://12') === 'Untitled-12', '两位数编号');
assert(mod.displayNameFor('app/service/a.php') === 'a.php', '普通路径取文件名');
assert(mod.displayNameFor('') === '编辑器', '空路径给兜底名');

console.log(`\n全部通过：${passed} 项`);
