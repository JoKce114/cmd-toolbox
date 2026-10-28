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

rmSync(outDir, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);
