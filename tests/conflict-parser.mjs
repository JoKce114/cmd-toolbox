import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const outDir = mkdtempSync(join(tmpdir(), 'cmdtb-parser-'));

execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'tsc',
    'src/conflictParser.ts',
    '--outDir',
    outDir,
    '--module',
    'esnext',
    '--target',
    'es2022',
    '--moduleResolution',
    'bundler',
    '--skipLibCheck',
  ],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
);

const compiled = join(outDir, 'conflictParser.js');
const { parseConflicts, resolveConflict } = await import(pathToFileURL(compiled).href);

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const STANDARD = ['a', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> feature/x', 'b'].join('\n');
const DIFF3 = ['<<<<<<< HEAD', 'ours', '||||||| base', 'base', '=======', 'theirs', '>>>>>>> feature/x'].join('\n');

console.log('1. 标准标记');
const one = parseConflicts(STANDARD);
assert(one.length === 1, '识别一个冲突块');
assert(one[0].startLine === 1 && one[0].separatorLine === 3 && one[0].endLine === 5, '行号正确（0 基）');
assert(one[0].baseLine === null, '标准形式没有基线段');
assert(one[0].oursLabel === 'HEAD', 'ours 标签正确');
assert(one[0].theirsLabel === 'feature/x', 'theirs 标签正确');

console.log('2. diff3 标记');
const d3 = parseConflicts(DIFF3);
assert(d3.length === 1, '识别 diff3 冲突块');
assert(d3[0].baseLine === 2, '基线段行号正确');

console.log('3. 多块');
const twoBlocks = [STANDARD, '', STANDARD].join('\n');
assert(parseConflicts(twoBlocks).length === 2, '识别两个冲突块');

console.log('4. 不完整标记返回空');
assert(parseConflicts(['<<<<<<< HEAD', 'ours', '=======', 'theirs'].join('\n')).length === 0, '缺少结束标记返回空');
assert(parseConflicts(['<<<<<<< HEAD', 'ours', '>>>>>>> x'].join('\n')).length === 0, '缺少分隔线返回空');

console.log('5. 无冲突');
assert(parseConflicts('hello\nworld').length === 0, '普通文本返回空');
assert(parseConflicts(['a', '<<<<<<< 出现在中间', 'b'].join('\n')).length === 0, '非行首标记不识别');

console.log('6. 采用当前');
const oursResult = resolveConflict(STANDARD, one[0], 'ours');
const applied = STANDARD.slice(0, oursResult.from) + oursResult.insert + STANDARD.slice(oursResult.to);
assert(applied === 'a\nours\nb', '采用当前后内容正确');

console.log('7. 采用传入');
const theirsResult = resolveConflict(STANDARD, one[0], 'theirs');
const appliedTheirs = STANDARD.slice(0, theirsResult.from) + theirsResult.insert + STANDARD.slice(theirsResult.to);
assert(appliedTheirs === 'a\ntheirs\nb', '采用传入后内容正确');

console.log('8. 两者都保留');
const bothResult = resolveConflict(STANDARD, one[0], 'both');
const appliedBoth = STANDARD.slice(0, bothResult.from) + bothResult.insert + STANDARD.slice(bothResult.to);
assert(appliedBoth === 'a\nours\ntheirs\nb', '两者都保留后内容正确');

console.log('9. diff3 采用当前丢弃基线段');
const d3Result = resolveConflict(DIFF3, d3[0], 'ours');
assert(DIFF3.slice(0, d3Result.from) + d3Result.insert + DIFF3.slice(d3Result.to) === 'ours', 'diff3 采用当前后只剩当前内容');

console.log('10. 空的实际内容不会留下多余空行');
const EMPTY_OURS = ['a', '<<<<<<< HEAD', '=======', 'theirs', '>>>>>>> x', 'b'].join('\n');
const emptyOurs = parseConflicts(EMPTY_OURS);
assert(emptyOurs.length === 1, '空当前段仍识别为一个冲突块');
const emptyOursResult = resolveConflict(EMPTY_OURS, emptyOurs[0], 'ours');
assert(
  EMPTY_OURS.slice(0, emptyOursResult.from) + emptyOursResult.insert + EMPTY_OURS.slice(emptyOursResult.to) === 'a\nb',
  '采用当前（空段）后没有多余空行',
);
const emptyOursTheirs = resolveConflict(EMPTY_OURS, emptyOurs[0], 'theirs');
assert(
  EMPTY_OURS.slice(0, emptyOursTheirs.from) + emptyOursTheirs.insert + EMPTY_OURS.slice(emptyOursTheirs.to) ===
    'a\ntheirs\nb',
  '采用传入（空当前段）后内容正确',
);
const EMPTY_OURS_EOF = ['a', '<<<<<<< HEAD', '=======', 'theirs', '>>>>>>> x', ''].join('\n');
const emptyOursEof = parseConflicts(EMPTY_OURS_EOF);
const emptyOursEofResult = resolveConflict(EMPTY_OURS_EOF, emptyOursEof[0], 'ours');
assert(
  EMPTY_OURS_EOF.slice(0, emptyOursEofResult.from) + emptyOursEofResult.insert + EMPTY_OURS_EOF.slice(emptyOursEofResult.to) ===
    'a\n',
  '文件末尾的空段不产生多余空行',
);

console.log('11. 八个等号是内容而非分隔线');
const EIGHT_EQUALS = [
  'a',
  '<<<<<<< HEAD',
  'ours',
  '========',
  'more',
  '=======',
  'theirs',
  '>>>>>>> x',
  'b',
].join('\n');
const eightBlocks = parseConflicts(EIGHT_EQUALS);
assert(eightBlocks.length === 1, '仍识别为一个冲突块');
assert(eightBlocks[0].separatorLine === 5, '真正的分隔线被识别（行号 5）');
const eightTheirs = resolveConflict(EIGHT_EQUALS, eightBlocks[0], 'theirs');
assert(
  EIGHT_EQUALS.slice(0, eightTheirs.from) + eightTheirs.insert + EIGHT_EQUALS.slice(eightTheirs.to) === 'a\ntheirs\nb',
  '采用传入后不残留真实标记',
);

rmSync(outDir, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);
