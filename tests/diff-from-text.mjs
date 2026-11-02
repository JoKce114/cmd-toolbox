// 两段文本 → unified diff。离线可跑，不依赖 GUI。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

// 直连 TS 需要 Node >= 22.7；用 strip-types 在测试运行时转译
const { buildTextPatch } = await import('../src/diffFromText.ts');

console.log('1. 相同内容');
assert(buildTextPatch('a', 'x\ny', 'b', 'x\ny') === '', '完全相同返回空串');

console.log('2. 新增行');
const added = buildTextPatch('a', 'x', 'b', 'x\ny');
assert(added.includes('--- a'), '带旧文件名');
assert(added.includes('+++ b'), '带新文件名');
assert(added.includes('@@'), '带 hunk 头');
assert(added.includes('+y'), '新增行带 + 前缀');
assert(!added.includes('-x'), '未改动行不加 -');

console.log('3. 删除行');
const removed = buildTextPatch('a', 'x\ny', 'b', 'x');
assert(removed.includes('-y'), '删除行带 - 前缀');

console.log('4. 修改行');
const changed = buildTextPatch('a', 'x\ny\nz', 'b', 'x\nY\nz');
assert(changed.includes('-y'), '旧内容标删除');
assert(changed.includes('+Y'), '新内容标新增');

console.log('5. 空文件');
const fromEmpty = buildTextPatch('a', '', 'b', 'x');
assert(fromEmpty.includes('+x'), '空文件到有内容标新增');
const toEmpty = buildTextPatch('a', 'x', 'b', '');
assert(toEmpty.includes('-x'), '有内容到空文件标删除');

console.log('6. 多段不连续改动');
const multi = buildTextPatch('a', 'a\nb\nc\nd\ne', 'b', 'A\nb\nc\nd\nE');
const hunks = (multi.match(/^@@/gm) || []).length;
assert(hunks >= 1, `至少一个 hunk，实际 ${hunks}`);

console.log(`\n全部通过：${passed} 项`);
