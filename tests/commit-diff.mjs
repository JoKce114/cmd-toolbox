import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const git = require('../desktop/git.js');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

// src/ 下是 TS，Node 不能直接 import；用本地 tsc 编译成 CJS 到临时目录再 require
const buildDir = mkdtempSync(join(tmpdir(), 'cmdtb-ts-'));
execFileSync(
  process.execPath,
  [
    join(root, 'node_modules/typescript/bin/tsc'),
    'src/commitDiff.ts',
    'src/diffParser.ts',
    '--outDir',
    buildDir,
    '--module',
    'commonjs',
    '--target',
    'es2022',
    '--moduleResolution',
    'node',
    '--skipLibCheck',
  ],
  { cwd: root, stdio: 'inherit' },
);
const { splitCommitPatch } = require(join(buildDir, 'commitDiff.js'));

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'cmdtb-cdiff-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
  execFileSync('git', ['config', 'diff.renames', 'true'], { cwd: dir });
  return dir;
}

const repo = makeRepo();
writeFileSync(join(repo, 'keep.txt'), 'one\n');
writeFileSync(join(repo, 'gone.txt'), 'two\n');
writeFileSync(join(repo, 'old.txt'), 'old\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-m', '初始'], { cwd: repo });

writeFileSync(join(repo, 'keep.txt'), 'one changed\n');
rmSync(join(repo, 'gone.txt'));
writeFileSync(join(repo, 'brand-new.txt'), 'new\n');
execFileSync('git', ['mv', 'old.txt', 'renamed.txt'], { cwd: repo });
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-m', '第二'], { cwd: repo });
const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

console.log('1. 多文件 patch 切分');
const { patch } = await git.commitDiff(repo, hash);
const files = splitCommitPatch(patch);
const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
assert(files.length === 4, '切成 4 块');
assert(
  byPath['keep.txt'].status === 'modified' &&
    byPath['keep.txt'].added === 1 &&
    byPath['keep.txt'].removed === 1,
  '修改文件的状态与增删数正确',
);
assert(
  byPath['gone.txt'].status === 'deleted' && byPath['gone.txt'].removed === 1,
  '删除文件识别正确',
);
assert(
  byPath['brand-new.txt'].status === 'added' && byPath['brand-new.txt'].added === 1,
  '新增文件识别正确',
);
assert(
  byPath['renamed.txt'].status === 'renamed' && byPath['renamed.txt'].origPath === 'old.txt',
  '重命名识别正确且保留原路径',
);

console.log('2. 非法与不存在的提交');
let hashError = '';
try {
  await git.commitDiff(repo, 'HEAD; rm -rf /');
} catch (error) {
  hashError = error.message;
}
assert(hashError.includes('不合法'), '非法 hash 被拒绝');

let missingError = '';
try {
  await git.commitDiff(repo, 'deadbeef');
} catch (error) {
  missingError = error.message;
}
assert(missingError.includes('不在本地历史'), '不存在的提交给出明确提示');

console.log('3. merge commit 相对第一父');
execFileSync('git', ['checkout', '-b', 'side'], { cwd: repo });
writeFileSync(join(repo, 'side.txt'), 'side\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-m', 'side 提交'], { cwd: repo });
execFileSync('git', ['checkout', 'main'], { cwd: repo });
writeFileSync(join(repo, 'main.txt'), 'main\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-m', 'main 提交'], { cwd: repo });
execFileSync('git', ['merge', '--no-ff', 'side', '-m', '合并 side'], { cwd: repo });
const mergeHash = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repo,
  encoding: 'utf8',
}).trim();
const mergePatch = (await git.commitDiff(repo, mergeHash)).patch;
assert(mergePatch.trim().length > 0, 'merge commit 输出非空 diff');
const mergeFiles = splitCommitPatch(mergePatch);
assert(
  mergeFiles.some((file) => file.path === 'side.txt'),
  '包含来自被合并分支的文件',
);
assert(
  !mergeFiles.some((file) => file.path === 'main.txt'),
  '不含第一父已有的文件（--first-parent 生效）',
);

console.log('4. 头部误判 / 非 ASCII 路径 / 二进制');
const edge = makeRepo();
writeFileSync(join(edge, 'notes.txt'), '-- old comment\n');
writeFileSync(join(edge, '中文.txt'), 'a\n');
writeFileSync(join(edge, 'blob.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
execFileSync('git', ['add', '-A'], { cwd: edge });
execFileSync('git', ['commit', '-m', '边缘初始'], { cwd: edge });

rmSync(join(edge, 'notes.txt'));
writeFileSync(join(edge, '中文.txt'), 'b\n');
writeFileSync(join(edge, 'blob.dat'), Buffer.from([0, 9, 9, 9, 0, 254]));
execFileSync('git', ['add', '-A'], { cwd: edge });
execFileSync('git', ['commit', '-m', '边缘第二'], { cwd: edge });
const edgeHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: edge, encoding: 'utf8' }).trim();

const edgeFiles = splitCommitPatch((await git.commitDiff(edge, edgeHash)).patch);
const edgeByPath = Object.fromEntries(edgeFiles.map((file) => [file.path, file]));
assert(
  edgeByPath['notes.txt']?.status === 'deleted' &&
    edgeFiles.filter((file) => file.path === 'notes.txt').length === 1,
  'hunk 正文的 --- / +++ 行不会冒充文件头',
);
assert(edgeByPath['中文.txt']?.status === 'modified', '非 ASCII 路径保持原文、不加引号转义');
assert(edgeByPath['blob.dat']?.status === 'modified', '二进制文件不被丢弃');

rmSync(buildDir, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);
