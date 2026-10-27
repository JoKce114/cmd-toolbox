import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
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
  withFiles.changes.some((c) => c.path === '中文 文件.txt' && c.worktreeStatus === 'untracked'),
  '中文空格路径原样返回，未加引号',
);

console.log('3b. 双状态字段');
const dual = await git.status(repo);
const phpChange = dual.changes.find((c) => c.path === 'index.php');
assert(phpChange.indexStatus === null && phpChange.worktreeStatus === 'untracked', '未跟踪文件只有工作区状态');
assert(dual.stagedCount === 0 && dual.unstagedCount === 2, '计数按双状态统计');

console.log('4. 暂存后提交');
await git.stage(repo, ['index.php', '中文 文件.txt']);
const staged = await git.status(repo);
assert(staged.stagedCount === 2 && staged.unstagedCount === 0, '暂存后两个文件进入暂存区');
const result = await git.commit(repo, '首次提交');
assert(result.summary === '首次提交', '返回提交摘要');
const logged = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repo, encoding: 'utf8' }).trim();
assert(logged === '首次提交', 'git log 中的提交信息一致');
const afterCommit = await git.status(repo);
assert(afterCommit.hasChanges === false, '提交后工作区干净');

console.log('5. 同时有暂存与工作区改动');
writeFileSync(join(repo, 'index.php'), '<?php echo 2;\n');
await git.stage(repo, ['index.php']);
writeFileSync(join(repo, 'index.php'), '<?php echo 3;\n');
const mixed = await git.status(repo);
const mixedChange = mixed.changes.find((c) => c.path === 'index.php');
assert(mixedChange.indexStatus === 'modified' && mixedChange.worktreeStatus === 'modified', '同一文件两处状态都在');
assert(mixed.stagedCount === 1 && mixed.unstagedCount === 1, '两个计数都计入该文件');

console.log('5b. 取消暂存');
await git.unstage(repo, ['index.php']);
const unstaged = await git.status(repo);
const unstagedChange = unstaged.changes.find((c) => c.path === 'index.php');
assert(unstagedChange.indexStatus === null, '取消暂存后暂存区状态为空');
assert(unstagedChange.worktreeStatus === 'modified', '工作区改动保留');

console.log('5c. 放弃已跟踪文件的修改');
await git.discard(repo, { tracked: ['index.php'], untracked: [] });
assert(readFileSync(join(repo, 'index.php'), 'utf8') === '<?php echo 1;\n', '内容恢复到已提交版本');

console.log('5d. 放弃未跟踪文件等于删除');
writeFileSync(join(repo, 'scratch.txt'), 'x\n');
await git.discard(repo, { tracked: [], untracked: ['scratch.txt'] });
assert(!existsSync(join(repo, 'scratch.txt')), '未跟踪文件已删除');

console.log('5e. 全部暂存与全部放弃');
writeFileSync(join(repo, 'index.php'), '<?php echo 4;\n');
await git.stageAll(repo);
const allStaged = await git.status(repo);
assert(allStaged.unstagedCount === 0 && allStaged.stagedCount >= 1, '全部暂存后工作区无改动');
await git.discardAll(repo);
const allDiscarded = await git.status(repo);
assert(allDiscarded.hasChanges === false, '全部放弃后工作区干净');

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

console.log('10. 命令注入相关字符被拒绝');
let percentRejected = false;
try {
  await git.diffCommand(repo, '100%PATH%done.txt', 'modified');
} catch {
  percentRejected = true;
}
assert(percentRejected, '拒绝含 % 的路径（cmd 会展开变量）');

console.log('11. 初始化仓库');
const fresh = mkdtempSync(join(tmpdir(), 'cmdtb-init-'));
writeFileSync(join(fresh, 'a.txt'), 'a\n');
await git.init(fresh);
const inited = await git.status(fresh);
assert(inited.ok === true && inited.hasChanges === true, '初始化后能看到未跟踪文件');

console.log('12. 分支列表与切换');
const branchInfo = await git.branches(repo);
assert(branchInfo.current === 'main', '当前分支为 main');
assert(branchInfo.list[0] === 'main', '当前分支置顶');
await git.createBranch(repo, 'feature-a', 'main');
const afterCreate = await git.branches(repo);
assert(afterCreate.current === 'feature-a', '新建后立即切换');
assert(afterCreate.list.includes('main') && afterCreate.list.includes('feature-a'), '两个分支都在列表');

writeFileSync(join(repo, 'a.txt'), 'feature\n');
await git.stageAll(repo);
await git.commit(repo, 'feature 提交');
await git.checkout(repo, 'main');
const backToMain = await git.branches(repo);
assert(backToMain.current === 'main', '切回 main');

console.log('13. 合并');
const mergeResult = await git.merge(repo, 'feature-a');
assert(mergeResult.ok === true && mergeResult.conflicted.length === 0, '无冲突合并成功');
assert(existsSync(join(repo, 'a.txt')), '合并后文件出现');

console.log('14. 合并冲突不抛错');
await git.checkout(repo, 'feature-a');
writeFileSync(join(repo, 'a.txt'), 'feature 版本\n');
await git.stageAll(repo);
await git.commit(repo, 'feature 改 a');
await git.checkout(repo, 'main');
writeFileSync(join(repo, 'a.txt'), 'main 版本\n');
await git.stageAll(repo);
await git.commit(repo, 'main 改 a');
const conflictResult = await git.merge(repo, 'feature-a');
assert(conflictResult.conflicted.includes('a.txt'), '返回冲突文件列表');
const afterConflict = await git.status(repo);
assert(
  afterConflict.changes.some((c) => c.path === 'a.txt' && c.indexStatus === 'conflicted'),
  '状态中标记为冲突',
);
execFileSync('git', ['merge', '--abort'], { cwd: repo });

console.log('15. 分支名校验');
let badName = '';
try {
  await git.createBranch(repo, 'bad name', 'main');
} catch (error) {
  badName = error.message;
}
assert(badName.length > 0, '非法分支名被拒绝');

console.log(`\n全部通过：${passed} 项`);
