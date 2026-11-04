// blame 与单文件提交 diff。离线可跑，用临时仓库。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const git = require('../desktop/git.js');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const repo = mkdtempSync(join(tmpdir(), 'cmdtb-blame-'));
execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 'Alice'], { cwd: repo });
execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });

writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
execFileSync('git', ['add', '.'], { cwd: repo });
execFileSync('git', ['commit', '-m', '首次提交'], { cwd: repo });

const first = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

console.log('1. blame 命中');
const hit = await git.blame(repo, 'a.txt', 2);
assert(hit !== null, '能拿到 blame 结果');
assert(hit.author === 'Alice', '作者正确');
assert(hit.summary === '首次提交', '提交信息正确');
assert(hit.origLine === 2, 'origLine 为 2');
assert(hit.short === first.slice(0, 7), '短哈希正确');

console.log('2. 越界行号被钳住');
const clamped = await git.blame(repo, 'a.txt', 999);
assert(clamped !== null, '越界行号仍然能查');

console.log('3. 未跟踪文件返回 null');
writeFileSync(join(repo, 'b.txt'), 'x\n');
const untracked = await git.blame(repo, 'b.txt', 1);
assert(untracked === null, '未跟踪文件返回 null');

console.log('4. 路径越界报错');
let escaped = false;
try {
  await git.blame(repo, '../outside.txt', 1);
} catch {
  escaped = true;
}
assert(escaped, '项目目录外的路径被拒绝');

console.log('5. 单文件提交 diff');
const shown = await git.showFileDiff(repo, first, 'a.txt');
assert(shown.patch.includes('+one'), '包含新增行');
assert(shown.patch.includes('a.txt'), '包含文件路径');

console.log('6. 非法提交标识报错');
let badHash = false;
try {
  await git.showFileDiff(repo, 'not a hash !!', 'a.txt');
} catch {
  badHash = true;
}
assert(badHash, '非法 hash 被拒绝');

console.log(`\n全部通过：${passed} 项`);
