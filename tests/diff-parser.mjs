import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const outDir = mkdtempSync(join(tmpdir(), 'cmdtb-diff-'));

execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'tsc',
    'src/diffParser.ts',
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

const { parsePatch } = await import(pathToFileURL(join(outDir, 'diffParser.js')).href);

let passed = 0;
const assert = (cond, msg) => {
  if (!cond) throw new Error(`断言失败：${msg}`);
  passed += 1;
  console.log('  ok  ' + msg);
};

const PATCH = [
  'diff --git a/a.txt b/a.txt',
  'index 4cb29ea..6addb9b 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,4 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '+four',
  '',
].join('\n');

console.log('1. 基本解析');
const parsed = parsePatch(PATCH);
assert(parsed.hunks.length === 1, '一个 hunk');
assert(parsed.added === 2, '新增 2 行');
assert(parsed.removed === 1, '删除 1 行');
assert(parsed.isEmpty === false, '非空');

console.log('2. 行类型与行号');
const lines = parsed.hunks[0].lines;
assert(lines[0].kind === 'context' && lines[0].oldLine === 1 && lines[0].newLine === 1, '上下文行号');
assert(lines[1].kind === 'removed' && lines[1].oldLine === 2 && lines[1].newLine === null, '删除行只有旧行号');
assert(lines[2].kind === 'added' && lines[2].oldLine === null && lines[2].newLine === 2, '新增行只有新行号');
assert(lines[4].kind === 'added' && lines[4].newLine === 4, '末尾新增行号正确');

console.log('3. 多个 hunk');
const twoHunks = parsePatch(
  [
    '@@ -1,2 +1,2 @@',
    ' a',
    '-b',
    '+B',
    '@@ -10,2 +10,2 @@',
    ' x',
    '-y',
    '+Y',
  ].join('\n'),
);
assert(twoHunks.hunks.length === 2, '两个 hunk');
assert(twoHunks.hunks[1].lines[1].oldLine === 11, '第二个 hunk 起始行号取自头部');

console.log('4. 空 patch');
assert(parsePatch('').isEmpty === true, '空字符串为空');
assert(parsePatch('   ').isEmpty === true, '只有空白为空');

console.log('5. 无换行标记被忽略');
const noNewline = parsePatch(
  ['@@ -1 +1 @@', '-a', '+b', '\\ No newline at end of file'].join('\n'),
);
assert(noNewline.hunks[0].lines.length === 2, '反斜杠提示不占行');

rmSync(outDir, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);
