import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const git = require('../desktop/git.js');

let passed = 0;
const assert = (cond, msg) => {
  if (!cond) throw new Error(`断言失败：${msg}`);
  passed += 1;
  console.log('  ok  ' + msg);
};
const run = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
const head = (cwd) => run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'mi-'));
  run(dir, ['init', '-b', 'main']);
  run(dir, ['config', 'user.email', 'test@example.com']);
  run(dir, ['config', 'user.name', 'Test']);
  run(dir, ['config', 'commit.gpgsign', 'false']);
  run(dir, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  run(dir, ['add', '-A']);
  run(dir, ['commit', '-qm', 'init']);
  return dir;
}

console.log('1. A 合并到非当前的 B，完成后切回');
const repo = makeRepo();
run(repo, ['checkout', '-q', '-b', 'feature']);
writeFileSync(join(repo, 'feature.txt'), 'f\n');
run(repo, ['add', '-A']);
run(repo, ['commit', '-qm', 'feature work']);
run(repo, ['checkout', '-q', 'main']);
run(repo, ['checkout', '-q', '-b', 'develop']);
assert(head(repo) === 'develop', '初始在 develop');

const r1 = await git.mergeInto(repo, 'feature', 'main');
assert(r1.ok === true && r1.conflicted.length === 0, '合并成功无冲突');
assert(r1.switchedFrom === 'develop', '记录了切换前的分支');
assert(r1.returnedTo === 'develop', '合并后切回 develop');
assert(head(repo) === 'develop', '当前分支已还原');
run(repo, ['checkout', '-q', 'main']);
assert(readFileSync(join(repo, 'feature.txt'), 'utf8') === 'f\n', 'main 上已包含 feature 的提交');
run(repo, ['checkout', '-q', 'develop']);

console.log('2. 目标是当前分支时不切换');
run(repo, ['checkout', '-q', 'main']);
const r2 = await git.mergeInto(repo, 'feature', 'main');
assert(r2.switchedFrom === '', '未发生切换');
assert(head(repo) === 'main', '仍在 main');

console.log('3. 源与目标相同被拒绝');
let same = '';
try {
  await git.mergeInto(repo, 'main', 'main');
} catch (error) {
  same = error.message;
}
assert(same.includes('不能相同'), '提示源目标不能相同');

console.log('4. 工作区有改动时拒绝切换合并');
run(repo, ['checkout', '-q', 'develop']);
writeFileSync(join(repo, 'base.txt'), 'dirty\n');
let dirty = '';
try {
  await git.mergeInto(repo, 'feature', 'main');
} catch (error) {
  dirty = error.message;
}
assert(dirty.includes('未提交'), '提示先提交或放弃');
assert(head(repo) === 'develop', '分支未变');
run(repo, ['checkout', '--', 'base.txt']);

console.log('5. 冲突时停在目标分支并返回冲突列表');
const conflictRepo = makeRepo();
run(conflictRepo, ['checkout', '-q', '-b', 'feature']);
writeFileSync(join(conflictRepo, 'base.txt'), 'feature version\n');
run(conflictRepo, ['commit', '-qam', 'feature edit']);
run(conflictRepo, ['checkout', '-q', 'main']);
writeFileSync(join(conflictRepo, 'base.txt'), 'main version\n');
run(conflictRepo, ['commit', '-qam', 'main edit']);
run(conflictRepo, ['checkout', '-q', '-b', 'develop']);

const r5 = await git.mergeInto(conflictRepo, 'feature', 'main');
assert(r5.conflicted.includes('base.txt'), '返回冲突文件');
assert(head(conflictRepo) === 'main', '冲突时停在目标分支 main');
assert(r5.returnedTo === '', '冲突时不切回');
run(conflictRepo, ['merge', '--abort']);
run(conflictRepo, ['checkout', '-q', 'develop']);

console.log(`\n全部通过：${passed} 项`);
