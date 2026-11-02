// 两段文本 → unified diff。离线可跑，不依赖 GUI。
import { performance } from 'node:perf_hooks';

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

// 直连 TS 需要 Node >= 22.7；用 strip-types 在测试运行时转译
const { buildTextPatch } = await import('../src/diffFromText.ts');
const { parsePatch } = await import('../src/diffParser.ts');

function hunkLines(patch) {
  const parsed = parsePatch(patch);
  assert(parsed.hunks.length >= 1, 'patch 能被 parsePatch 解析出 hunk');
  return parsed.hunks[0].lines;
}

function findLine(lines, kind, text) {
  return lines.find((line) => line.kind === kind && line.text === text);
}

console.log('1. 相同内容');
assert(buildTextPatch('a', 'x\ny', 'b', 'x\ny') === '', '完全相同返回空串');

console.log('2. 新增行');
const added = buildTextPatch('a', 'x', 'b', 'x\ny');
assert(added.includes('--- a'), '带旧文件名');
assert(added.includes('+++ b'), '带新文件名');
assert(added.includes('@@'), '带 hunk 头');
assert(added.includes('+y'), '新增行带 + 前缀');
assert(!added.includes('-x'), '未改动行不加 -');
assert(added.endsWith('\n'), 'patch 末尾带换行');
{
  const lines = hunkLines(added);
  const context = findLine(lines, 'context', 'x');
  const inserted = findLine(lines, 'added', 'y');
  assert(context?.oldLine === 1 && context?.newLine === 1, '上下文 x 的 oldLine/newLine 为 1/1');
  assert(inserted?.oldLine === null && inserted?.newLine === 2, '新增 y 的 newLine 为 2');
}

console.log('3. 删除行');
const removed = buildTextPatch('a', 'x\ny', 'b', 'x');
assert(removed.includes('-y'), '删除行带 - 前缀');
{
  const lines = hunkLines(removed);
  const context = findLine(lines, 'context', 'x');
  const deleted = findLine(lines, 'removed', 'y');
  assert(context?.oldLine === 1 && context?.newLine === 1, '上下文 x 的 oldLine/newLine 为 1/1');
  assert(deleted?.oldLine === 2 && deleted?.newLine === null, '删除 y 的 oldLine 为 2');
}

console.log('4. 修改行');
const changed = buildTextPatch('a', 'x\ny\nz', 'b', 'x\nY\nz');
assert(changed.includes('-y'), '旧内容标删除');
assert(changed.includes('+Y'), '新内容标新增');
{
  const lines = hunkLines(changed);
  const contextX = findLine(lines, 'context', 'x');
  const oldY = findLine(lines, 'removed', 'y');
  const newY = findLine(lines, 'added', 'Y');
  const contextZ = findLine(lines, 'context', 'z');
  assert(contextX?.oldLine === 1 && contextX?.newLine === 1, '上下文 x 的 oldLine/newLine 为 1/1');
  assert(oldY?.oldLine === 2 && oldY?.newLine === null, '删除 y 的 oldLine 为 2');
  assert(newY?.oldLine === null && newY?.newLine === 2, '新增 Y 的 newLine 为 2');
  assert(contextZ?.oldLine === 3 && contextZ?.newLine === 3, '上下文 z 的 oldLine/newLine 为 3/3');
}

console.log('5. 空文件');
const fromEmpty = buildTextPatch('a', '', 'b', 'x');
assert(fromEmpty.includes('+x'), '空文件到有内容标新增');
{
  const lines = hunkLines(fromEmpty);
  const inserted = findLine(lines, 'added', 'x');
  assert(inserted?.oldLine === null && inserted?.newLine === 1, '新增 x 的 newLine 为 1');
}
const toEmpty = buildTextPatch('a', 'x', 'b', '');
assert(toEmpty.includes('-x'), '有内容到空文件标删除');
{
  const lines = hunkLines(toEmpty);
  const deleted = findLine(lines, 'removed', 'x');
  assert(deleted?.oldLine === 1 && deleted?.newLine === null, '删除 x 的 oldLine 为 1');
}

console.log('6. 多段不连续改动');
{
  const oldLines = Array.from({ length: 30 }, (_, index) => `line${index + 1}`);
  const newLines = [...oldLines];
  newLines[2] = 'changed-3';
  newLines[26] = 'changed-27';
  const multi = buildTextPatch('a', oldLines.join('\n'), 'b', newLines.join('\n'));
  const parsed = parsePatch(multi);
  assert(parsed.hunks.length === 2, `产生 2 个 hunk，实际 ${parsed.hunks.length}`);
  const secondHeader = parsed.hunks[1].header.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
  assert(
    secondHeader && Number(secondHeader[1]) === 24,
    `第二个 hunk 的旧文件起点为 24，实际 ${secondHeader ? secondHeader[1] : '无法解析'}`,
  );
  assert(
    secondHeader && Number(secondHeader[3]) === 24,
    `第二个 hunk 的新文件起点为 24，实际 ${secondHeader ? secondHeader[3] : '无法解析'}`,
  );
  const firstRemoved = findLine(parsed.hunks[0].lines, 'removed', 'line3');
  const firstAdded = findLine(parsed.hunks[0].lines, 'added', 'changed-3');
  assert(firstRemoved?.oldLine === 3, '第一个 hunk 删除的 line3 oldLine 为 3');
  assert(firstAdded?.newLine === 3, '第一个 hunk 新增的 changed-3 newLine 为 3');
  const secondRemoved = findLine(parsed.hunks[1].lines, 'removed', 'line27');
  const secondAdded = findLine(parsed.hunks[1].lines, 'added', 'changed-27');
  assert(secondRemoved?.oldLine === 27, '第二个 hunk 删除的 line27 oldLine 为 27');
  assert(secondAdded?.newLine === 27, '第二个 hunk 新增的 changed-27 newLine 为 27');
}

console.log('7. 改动在第一行');
{
  const first = buildTextPatch('a', 'a\nb\nc\nd\ne', 'b', 'A\nb\nc\nd\ne');
  const lines = hunkLines(first);
  const deleted = findLine(lines, 'removed', 'a');
  const inserted = findLine(lines, 'added', 'A');
  const context = findLine(lines, 'context', 'b');
  assert(deleted?.oldLine === 1, '删除首行 a 的 oldLine 为 1');
  assert(inserted?.newLine === 1, '新增首行 A 的 newLine 为 1');
  assert(context?.oldLine === 2 && context?.newLine === 2, '上下文 b 的 oldLine/newLine 为 2/2');
}

console.log('8. 改动在最后一行');
{
  const last = buildTextPatch('a', 'a\nb\nc\nd\ne', 'b', 'a\nb\nc\nd\nE');
  const lines = hunkLines(last);
  const deleted = findLine(lines, 'removed', 'e');
  const inserted = findLine(lines, 'added', 'E');
  const context = findLine(lines, 'context', 'd');
  assert(deleted?.oldLine === 5, '删除末行 e 的 oldLine 为 5');
  assert(inserted?.newLine === 5, '新增末行 E 的 newLine 为 5');
  assert(context?.oldLine === 4 && context?.newLine === 4, '上下文 d 的 oldLine/newLine 为 4/4');
}

console.log('9. 大文件：10000 行全不同');
{
  const size = 10000;
  const oldText = Array.from({ length: size }, (_, index) => `old line ${index}`).join('\n');
  const newText = Array.from({ length: size }, (_, index) => `new line ${index}`).join('\n');
  const started = performance.now();
  const bigPatch = buildTextPatch('a', oldText, 'b', newText);
  const elapsed = performance.now() - started;
  assert(bigPatch.length > 0, '大文件生成非空 patch');
  assert(elapsed < 2000, `10000 行全不同在 2 秒内返回，实际 ${elapsed.toFixed(1)} ms`);
}

console.log('10. 两万行完全不同（行集合快路径）');
{
  const size = 20000;
  const oldText = Array.from({ length: size }, (_, index) => `old line ${index}`).join('\n');
  const newText = Array.from({ length: size }, (_, index) => `new line ${index}`).join('\n');
  const started = performance.now();
  const disjointPatch = buildTextPatch('a', oldText, 'b', newText);
  const elapsed = performance.now() - started;
  assert(elapsed < 500, `20000 行全不同在 500 ms 内返回，实际 ${elapsed.toFixed(1)} ms`);
  assert(disjointPatch.length > 0, '两万行全不同生成非空 patch');
  const parsed = parsePatch(disjointPatch);
  assert(parsed.hunks.length === 1, `两万行全不同只产生 1 个 hunk，实际 ${parsed.hunks.length}`);
  assert(
    parsed.hunks[0].header === '@@ -1,20000 +1,20000 @@',
    `hunk 头为 @@ -1,20000 +1,20000 @@，实际 ${parsed.hunks[0].header}`,
  );
  const removed = parsed.hunks[0].lines.filter((line) => line.kind === 'removed');
  const inserted = parsed.hunks[0].lines.filter((line) => line.kind === 'added');
  assert(removed.length === size && inserted.length === size, '正好是全部删除 + 全部新增');
}

console.log('11. 一万行仅一行相同（有交集，走正常差分）');
{
  const size = 10000;
  const sharedIndex = 5000;
  const sharedLine = 'shared line';
  const oldLines = Array.from({ length: size }, (_, index) => `old line ${index}`);
  const newLines = Array.from({ length: size }, (_, index) => `new line ${index}`);
  oldLines[sharedIndex] = sharedLine;
  newLines[sharedIndex] = sharedLine;
  const overlapping = buildTextPatch('a', oldLines.join('\n'), 'b', newLines.join('\n'));
  const parsed = parsePatch(overlapping);
  const contextLines = parsed.hunks
    .flatMap((hunk) => hunk.lines)
    .filter((line) => line.kind === 'context' && line.text === sharedLine);
  assert(contextLines.length === 1, `唯一相同的行作为上下文出现一次，实际 ${contextLines.length}`);
  assert(
    contextLines[0]?.oldLine === sharedIndex + 1 && contextLines[0]?.newLine === sharedIndex + 1,
    `上下文行的 oldLine/newLine 为 ${sharedIndex + 1}/${sharedIndex + 1}`,
  );
  const removed = parsed.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === 'removed');
  const inserted = parsed.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === 'added');
  assert(removed.length === size - 1 && inserted.length === size - 1, '其余行全部删除并新增');
}

console.log(`\n全部通过：${passed} 项`);
