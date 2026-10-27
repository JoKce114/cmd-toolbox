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

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'cmdtb-git-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

console.log('1. 非仓库与缺失目录');
const plain = mkdtempSync(join(tmpdir(), 'cmdtb-plain-'));
const plainStatus = await git.status(plain);
assert(plainStatus.ok === false && plainStatus.reason === 'not-repo', '普通目录返回 not-repo');
const missing = await git.status(join(plain, 'nope'));
assert(missing.ok === false && missing.reason === 'missing-dir', '不存在的目录返回 missing-dir');

console.log('2. 干净仓库');
const repo = makeRepo();
const clean = await git.status(repo);
assert(clean.ok === true && clean.hasChanges === false, '空仓库没有变更');
assert(clean.branch === 'main', '读到分支名 main');
assert(clean.upstream === '', '没有上游时 upstream 为空');

console.log('3. 中文与空格的未跟踪文件');
writeFileSync(join(repo, 'index.php'), '<?php echo 1;\n');
writeFileSync(join(repo, '中文 文件.txt'), 'hello\n');
const withFiles = await git.status(repo);
assert(withFiles.changes.length === 2, '识别到两个变更');
assert(
  withFiles.changes.some((c) => c.path === '中文 文件.txt' && c.status === 'untracked'),
  '中文空格路径原样返回，未加引号',
);

console.log('4. 提交');
const result = await git.commit(repo, '首次提交');
assert(result.summary === '首次提交', '返回提交摘要');
const logged = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repo, encoding: 'utf8' }).trim();
assert(logged === '首次提交', 'git log 中的提交信息一致');
const afterCommit = await git.status(repo);
assert(afterCommit.hasChanges === false, '提交后工作区干净');

console.log('5. 修改与删除状态');
writeFileSync(join(repo, 'index.php'), '<?php echo 2;\n');
execFileSync('git', ['add', '-A'], { cwd: repo });
writeFileSync(join(repo, 'index.php'), '<?php echo 3;\n');
const mixed = await git.status(repo);
assert(
  mixed.changes.some((c) => c.path === 'index.php' && c.status === 'modified'),
  '已暂存后又修改的文件标记为 modified',
);

console.log('6. 提交空信息被拒绝');
let rejected = false;
try {
  await git.commit(repo, '   ');
} catch {
  rejected = true;
}
assert(rejected, '空提交信息抛错');

console.log('7. 推送无上游');
let noUpstream = '';
try {
  await git.push(repo);
} catch (error) {
  noUpstream = error.message;
}
assert(noUpstream.includes('上游'), '无上游时提示中包含「上游」');
assert(noUpstream.includes('main'), '提示中包含分支名');

console.log('8. diff 命令生成');
const trackedDiff = await git.diffCommand(repo, 'index.php', 'modified');
assert(trackedDiff.command.includes('--no-pager diff --'), '已跟踪文件使用普通 diff');
assert(trackedDiff.command.includes('"index.php"'), '路径被双引号包裹');
const untrackedDiff = await git.diffCommand(repo, '中文 文件.txt', 'untracked');
assert(untrackedDiff.command.includes('--no-index'), '未跟踪文件使用 --no-index');

console.log('9. 路径越界被拒绝');
let escaped = false;
try {
  await git.diffCommand(repo, '../outside.txt', 'modified');
} catch {
  escaped = true;
}
assert(escaped, '拒绝项目目录之外的路径');

console.log('10. 初始化仓库');
const fresh = mkdtempSync(join(tmpdir(), 'cmdtb-init-'));
writeFileSync(join(fresh, 'a.txt'), 'a\n');
await git.init(fresh);
const inited = await git.status(fresh);
assert(inited.ok === true && inited.hasChanges === true, '初始化后能看到未跟踪文件');

console.log(`\n全部通过：${passed} 项`);
