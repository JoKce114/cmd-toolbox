import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

console.log('5c2. 取消暂存重命名');
execFileSync('git', ['mv', 'index.php', 'renamed.php'], { cwd: repo });
const renamedStatus = await git.status(repo);
const renameChange = renamedStatus.changes.find((c) => c.path === 'renamed.php');
assert(
  renameChange && renameChange.origPath === 'index.php',
  '重命名同时返回新旧路径',
);
await git.unstage(repo, ['index.php', 'renamed.php']);
const afterRenameUnstage = await git.status(repo);
assert(
  !afterRenameUnstage.changes.some(
    (c) => c.indexStatus === 'deleted' && c.path === 'index.php',
  ),
  '取消暂存重命名后没有残留的暂存删除',
);
assert(
  afterRenameUnstage.changes.some(
    (c) => c.path === 'index.php' && c.worktreeStatus === 'deleted',
  ),
  '原路径显示为工作区删除',
);
assert(
  afterRenameUnstage.changes.some(
    (c) => c.path === 'renamed.php' && c.worktreeStatus === 'untracked',
  ),
  '新路径显示为未跟踪',
);
execFileSync('git', ['restore', '--', 'index.php'], { cwd: repo });
rmSync(join(repo, 'renamed.php'), { force: true });

console.log('5d. 放弃未跟踪文件等于删除');
writeFileSync(join(repo, 'scratch.txt'), 'x\n');
await git.discard(repo, { tracked: [], untracked: ['scratch.txt'] });
assert(!existsSync(join(repo, 'scratch.txt')), '未跟踪文件已删除');

console.log('5d2. 放弃未跟踪目录递归删除');
mkdirSync(join(repo, 'newdir', 'nested'), { recursive: true });
writeFileSync(join(repo, 'newdir', 'a.txt'), 'a\n');
writeFileSync(join(repo, 'newdir', 'nested', 'b.txt'), 'b\n');
const dirStatus = await git.status(repo);
assert(
  dirStatus.changes.some(
    (c) => c.worktreeStatus === 'untracked' && c.path.startsWith('newdir/'),
  ),
  '未跟踪目录出现在状态中',
);
await git.discard(repo, { tracked: [], untracked: ['newdir/'] });
assert(!existsSync(join(repo, 'newdir')), '未跟踪目录被递归删除');
const afterDirDiscard = await git.status(repo);
assert(!afterDirDiscard.hasChanges, '放弃目录后状态干净');

console.log('5e. 全部暂存与全部放弃');
writeFileSync(join(repo, 'index.php'), '<?php echo 4;\n');
await git.stageAll(repo);
const allStaged = await git.status(repo);
assert(allStaged.unstagedCount === 0 && allStaged.stagedCount >= 1, '全部暂存后工作区无改动');
await git.discardAll(repo);
const allDiscarded = await git.status(repo);
assert(allDiscarded.hasChanges === false, '全部放弃后工作区干净');

console.log('5f. 空仓库的全部放弃');
const unborn = mkdtempSync(join(tmpdir(), 'cmdtb-unborn-'));
execFileSync('git', ['init', '-b', 'main'], { cwd: unborn, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: unborn });
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: unborn });
execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: unborn });
writeFileSync(join(unborn, 'only.txt'), 'x\n');
const unbornResult = await git.discardAll(unborn);
assert(unbornResult.ok === true, '空仓库全部放弃不报错');
const unbornAfter = await git.status(unborn);
assert(unbornAfter.hasChanges === false, '空仓库里的未跟踪文件被清除');

console.log('6. 提交空信息被拒绝');
let rejected = false;
try {
  await git.commit(repo, '   ');
} catch {
  rejected = true;
}
assert(rejected, '空提交信息抛错');

console.log('7. 推送无上游');
const noUpstreamResult = await git.push(repo);
assert(noUpstreamResult.ok === false && noUpstreamResult.reason === 'no-upstream', '无上游时返回 no-upstream');
assert(noUpstreamResult.message.includes('上游'), '提示中包含「上游」');
assert(noUpstreamResult.message.includes('main'), '提示中包含分支名');

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
let dashName = '';
try {
  await git.createBranch(repo, '-f', 'main');
} catch (error) {
  dashName = error.message;
}
assert(dashName.length > 0, '以 - 开头的分支名被拒绝');

console.log('16. 撤销提交');
const undoRepo = makeRepo();
writeFileSync(join(undoRepo, 'one.txt'), 'a\n');
await git.stageAll(undoRepo);
await git.commit(undoRepo, '第一次');
writeFileSync(join(undoRepo, 'two.txt'), 'b\n');
await git.stageAll(undoRepo);
await git.commit(undoRepo, '第二次');

const undone = await git.undoCommit(undoRepo);
assert(undone.message === '第二次', '返回被撤销提交的完整信息');
assert(undone.wasPushed === false, '无远端时标记为未推送');
const afterUndo = await git.status(undoRepo);
assert(afterUndo.ok && afterUndo.stagedCount === 1, '改动回到暂存区');
assert(
  execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: undoRepo, encoding: 'utf8' }).trim() ===
    '第一次',
  'HEAD 回退到上一个提交',
);

const firstUndo = await git.undoCommit(undoRepo);
assert(firstUndo.message === '第一次', '可继续撤销到首次提交');
assert((await git.headCommit(undoRepo)) === null, '撤销首次提交后没有 HEAD');
const unbornStatus = await git.status(undoRepo);
assert(unbornStatus.ok && unbornStatus.stagedCount === 2, '首次提交撤销后文件全部暂存');

console.log('17. 修改提交');
const amendRepo = makeRepo();
writeFileSync(join(amendRepo, 'a.txt'), 'a\n');
await git.stageAll(amendRepo);
await git.commit(amendRepo, '原始信息');
writeFileSync(join(amendRepo, 'b.txt'), 'b\n');
await git.stageAll(amendRepo);
const amended = await git.amend(amendRepo, '修改后的信息');
assert(amended.summary === '修改后的信息', '返回新的提交信息');
assert(
  execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: amendRepo, encoding: 'utf8' }).trim() ===
    '修改后的信息',
  '提交信息已更新',
);
assert(
  execFileSync('git', ['rev-list', '--count', 'HEAD'], {
    cwd: amendRepo,
    encoding: 'utf8',
  }).trim() === '1',
  '仍然只有一条提交',
);
assert(
  execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], {
    cwd: amendRepo,
    encoding: 'utf8',
  }).includes('b.txt'),
  '暂存改动并入提交',
);

let amendError = '';
try {
  await git.amend(amendRepo, '修改后的信息');
} catch (error) {
  amendError = error.message;
}
assert(amendError.includes('未修改'), '无变更时拒绝 amend');

const headRepo = makeRepo();
assert((await git.headCommit(headRepo)) === null, '空仓库 headCommit 返回 null');

console.log('18. HEAD 信息');
const headInfoRepo = makeRepo();
writeFileSync(join(headInfoRepo, 'readme.md'), 'hello\n');
await git.stageAll(headInfoRepo);
await git.commit(headInfoRepo, '主题行\n\n正文第一行\n正文第二行');
const info = await git.headCommit(headInfoRepo);
assert(/^[0-9a-f]{40}$/.test(info.hash), 'hash 是 40 位十六进制');
assert(info.hash.startsWith(info.short) && info.short.length >= 4, 'short 是 hash 的前缀');
assert(info.subject === '主题行', 'subject 只取第一行');
assert(info.message === '主题行\n\n正文第一行\n正文第二行', 'message 完整保留换行');
assert(info.pushed === false, '无远端时为未推送');

console.log('19. 推送状态');
const remoteDir = mkdtempSync(join(tmpdir(), 'cmdtb-remote-'));
execFileSync('git', ['init', '--bare'], { cwd: remoteDir, stdio: 'ignore' });
const pushRepo = makeRepo();
writeFileSync(join(pushRepo, 'a.txt'), 'a\n');
await git.stageAll(pushRepo);
await git.commit(pushRepo, '已推送');
execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: pushRepo });
execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: pushRepo, stdio: 'ignore' });
const pushedHead = await git.headCommit(pushRepo);
assert(pushedHead.pushed === true, '已推送的提交标记为已推送');
writeFileSync(join(pushRepo, 'b.txt'), 'b\n');
await git.stageAll(pushRepo);
await git.commit(pushRepo, '未推送');
const unpushedHead = await git.headCommit(pushRepo);
assert(unpushedHead.pushed === false, '未推送的提交标记为未推送');

console.log('20. 修改提交保留正文');
const amendBodyRepo = makeRepo();
writeFileSync(join(amendBodyRepo, 'a.txt'), 'a\n');
await git.stageAll(amendBodyRepo);
await git.commit(amendBodyRepo, '标题\n\n正文保留');
writeFileSync(join(amendBodyRepo, 'b.txt'), 'b\n');
await git.stageAll(amendBodyRepo);
const amendedSame = await git.amend(amendBodyRepo, '标题\n\n正文保留');
assert(amendedSame.summary === '标题', '相同信息走 --no-edit 并返回摘要');
assert(
  execFileSync('git', ['log', '-1', '--pretty=%B'], {
    cwd: amendBodyRepo,
    encoding: 'utf8',
  }).trim() === '标题\n\n正文保留',
  '--no-edit 保留原提交正文',
);
assert(
  execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], {
    cwd: amendBodyRepo,
    encoding: 'utf8',
  }).includes('b.txt'),
  '--no-edit 并入暂存改动',
);

console.log('21. 游离 HEAD 下撤销提交');
const detachedRepo = makeRepo();
writeFileSync(join(detachedRepo, 'a.txt'), 'a\n');
await git.stageAll(detachedRepo);
await git.commit(detachedRepo, '唯一提交');
execFileSync('git', ['checkout', '--detach', 'HEAD'], { cwd: detachedRepo, stdio: 'ignore' });
let detachedError = '';
try {
  await git.undoCommit(detachedRepo);
} catch (error) {
  detachedError = error.message;
}
assert(detachedError === '当前处于游离 HEAD 状态，无法撤销提交', '游离 HEAD 时拒绝撤销提交');
const detachedStatus = await git.status(detachedRepo);
assert(detachedStatus.ok === true, '拒绝后仓库仍然可用');
assert((await git.headCommit(detachedRepo)) !== null, '拒绝后 HEAD 未被删除');

console.log('21b. 浅克隆下撤销提交');
// depth 1 的克隆里 HEAD~1 不存在，但不能误判成「首个提交」而删掉分支引用
const shallowSource = makeRepo();
writeFileSync(join(shallowSource, 'a.txt'), 'a\n');
await git.stageAll(shallowSource);
await git.commit(shallowSource, '源仓库第一次');
writeFileSync(join(shallowSource, 'b.txt'), 'b\n');
await git.stageAll(shallowSource);
await git.commit(shallowSource, '源仓库第二次');
const shallowDir = join(mkdtempSync(join(tmpdir(), 'cmdtb-shallow-')), 'clone');
execFileSync(
  'git',
  ['clone', '--depth', '1', pathToFileURL(shallowSource).href, shallowDir],
  { stdio: 'ignore' },
);
let shallowError = '';
try {
  await git.undoCommit(shallowDir);
} catch (error) {
  shallowError = error.message;
}
assert(
  shallowError === '浅克隆仓库无法判断首个提交历史，未执行撤销',
  '浅克隆仓库拒绝撤销提交',
);
const shallowBranch = execFileSync('git', ['branch', '--show-current'], {
  cwd: shallowDir,
  encoding: 'utf8',
}).trim();
assert(shallowBranch === 'main', '拒绝后分支引用仍在');
const shallowHead = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
  cwd: shallowDir,
  encoding: 'utf8',
}).trim();
assert(/^[0-9a-f]{40}$/.test(shallowHead), '拒绝后 HEAD 仍然存在');

console.log('22. 提交历史');
const logRepo = makeRepo();
writeFileSync(join(logRepo, 'a.txt'), 'a\n');
await git.stageAll(logRepo);
await git.commit(logRepo, '第一条');
writeFileSync(join(logRepo, 'b.txt'), 'b\n');
await git.stageAll(logRepo);
await git.commit(logRepo, '修复  登录   超时');
writeFileSync(join(logRepo, 'c.txt'), 'c\n');
await git.stageAll(logRepo);
await git.commit(logRepo, '第三条');
const history = await git.log(logRepo);
assert(history.commits.length === 3, '返回全部三条提交');
const [latestLog, spacedLog, oldestLog] = history.commits;
assert(/^[0-9a-f]{40}$/.test(latestLog.hash), 'hash 为 40 位十六进制');
assert(latestLog.hash.startsWith(latestLog.short) && latestLog.short.length >= 4, 'short 是 hash 前缀');
assert(latestLog.author === 'Test', 'author 解析正确');
assert(latestLog.when.length > 0, 'when 非空');
assert(latestLog.subject === '第三条', 'subject 解析正确');
assert(spacedLog.subject === '修复  登录   超时', 'subject 保留多个空格');
assert(oldestLog.subject === '第一条', '按时间倒序返回');

console.log('18. stash');
const stashRepo = makeRepo();
writeFileSync(join(stashRepo, 'tracked.txt'), 'v1\n');
await git.stageAll(stashRepo);
await git.commit(stashRepo, '初始');
writeFileSync(join(stashRepo, 'tracked.txt'), 'v2\n');
writeFileSync(join(stashRepo, 'untracked.txt'), 'u\n');

await git.stashSave(stashRepo);
const cleanStatus = await git.status(stashRepo);
assert(
  cleanStatus.ok && cleanStatus.stagedCount === 0 && cleanStatus.unstagedCount === 0,
  '收起后工作区干净',
);
assert(!existsSync(join(stashRepo, 'untracked.txt')), '未跟踪文件一并收起');

const listed = await git.stashList(stashRepo);
assert(listed.stashes.length === 1, 'stash 列表有一条');
assert(/^stash@\{0\}$/.test(listed.stashes[0].ref), 'ref 格式正确');

await git.stashPop(stashRepo, listed.stashes[0].ref);
assert(readFileSync(join(stashRepo, 'tracked.txt'), 'utf8') === 'v2\n', '恢复后改动回来');
assert(existsSync(join(stashRepo, 'untracked.txt')), '未跟踪文件一并恢复');
assert((await git.stashList(stashRepo)).stashes.length === 0, '恢复后列表清空');

writeFileSync(join(stashRepo, 'tracked.txt'), 'v3\n');
await git.stashSave(stashRepo);
writeFileSync(join(stashRepo, 'untracked.txt'), 'u2\n');
await git.stashSave(stashRepo);
const twoStashes = await git.stashList(stashRepo);
assert(twoStashes.stashes.length === 2, '两次收起得到两条');
await git.stashDrop(stashRepo, twoStashes.stashes[0].ref);
assert((await git.stashList(stashRepo)).stashes.length === 1, '丢弃后剩一条');

let refError = '';
try {
  await git.stashDrop(stashRepo, 'stash@{-1}');
} catch (error) {
  refError = error.message;
}
assert(refError.includes('不合法'), '非法 stash ref 被拒绝');

let popError = '';
try {
  await git.stashPop(stashRepo, '../../x');
} catch (error) {
  popError = error.message;
}
assert(popError.includes('不合法'), '越界 stash ref 被拒绝');

let noChangeError = '';
try {
  await git.stashSave(stashRepo);
} catch (error) {
  noChangeError = error.message;
}
assert(noChangeError.includes('没有可收起的改动'), '无改动时给出提示');

console.log('18b. stash 恢复冲突');
const popRepo = makeRepo();
writeFileSync(join(popRepo, 'conflict.txt'), 'base\n');
await git.stageAll(popRepo);
await git.commit(popRepo, '基线');
writeFileSync(join(popRepo, 'conflict.txt'), 'stashed\n');
await git.stashSave(popRepo);
writeFileSync(join(popRepo, 'conflict.txt'), 'committed\n');
await git.stageAll(popRepo);
await git.commit(popRepo, '提交改动');

const popConflict = await git.stashPop(popRepo, 'stash@{0}');
assert(popConflict.ok === true, 'stashPop 冲突时仍返回 ok');
assert(popConflict.conflicts.includes('conflict.txt'), '返回冲突文件列表');
assert((await git.stashList(popRepo)).stashes.length === 1, '冲突后 stash 仍在列表');

console.log(`\n全部通过：${passed} 项`);
