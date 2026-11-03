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

const base = mkdtempSync(join(tmpdir(), 'pull-origin-'));
run(base, ['init', '--bare', '-b', 'main']);
const seed = mkdtempSync(join(tmpdir(), 'pull-seed-'));
run(seed, ['init', '-b', 'main']);
run(seed, ['config', 'user.email', 't@e.com']);
run(seed, ['config', 'user.name', 'T']);
run(seed, ['config', 'commit.gpgsign', 'false']);
writeFileSync(join(seed, 'a.txt'), 'one\n');
run(seed, ['add', '-A']);
run(seed, ['commit', '-qm', 'first']);
run(seed, ['remote', 'add', 'origin', base]);
run(seed, ['push', '-q', '-u', 'origin', 'main']);

const clone = (name) => {
  const dir = mkdtempSync(join(tmpdir(), `pull-${name}-`));
  run(tmpdir(), ['clone', '-q', base, dir]);
  run(dir, ['config', 'user.email', 't@e.com']);
  run(dir, ['config', 'user.name', 'T']);
  run(dir, ['config', 'commit.gpgsign', 'false']);
  run(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
};

// 其他克隆推送后 origin 会领先，seed 再推送前要先跟上
const syncSeed = () => {
  run(seed, ['fetch', '-q', 'origin']);
  run(seed, ['reset', '-q', '--hard', 'origin/main']);
};

console.log('1. fetch 让 behind 反映远端');
const local = clone('local');
const before = await git.status(local);
assert(before.behind === 0, '初始没有落后');

writeFileSync(join(seed, 'b.txt'), 'two\n');
run(seed, ['add', '-A']);
run(seed, ['commit', '-qm', 'second']);
run(seed, ['push', '-q', 'origin', 'main']);

const stale = await git.status(local);
assert(stale.behind === 0, '未 fetch 前本地看不到差距');
await git.fetchRemote(local);
const fetched = await git.status(local);
assert(fetched.behind === 1, 'fetch 后 behind 为 1');

console.log('2. pull --ff-only 快进');
const pulled = await git.pull(local);
assert(pulled.ok === true, '快进拉取成功');
assert(readFileSync(join(local, 'b.txt'), 'utf8') === 'two\n', '新文件已到位');
const afterPull = await git.status(local);
assert(afterPull.behind === 0, '拉取后不再落后');

console.log('3. 分叉时返回 diverged 而不是抛错');
const diverged = clone('diverged');
run(diverged, ['config', 'pull.rebase', 'false']);
writeFileSync(join(diverged, 'local-only.txt'), 'mine\n');
run(diverged, ['add', '-A']);
run(diverged, ['commit', '-qm', 'local work']);
writeFileSync(join(seed, 'c.txt'), 'three\n');
run(seed, ['add', '-A']);
run(seed, ['commit', '-qm', 'third']);
run(seed, ['push', '-q', 'origin', 'main']);
await git.fetchRemote(diverged);
const divergedResult = await git.pull(diverged);
assert(divergedResult.ok === false && divergedResult.reason === 'diverged', '分叉时返回 diverged');
assert(divergedResult.message.includes('分叉'), '分叉提示说明已分叉');

console.log('4. 分叉后可用合并方式拉取并推送');
const merged = await git.pull(diverged, { strategy: 'merge' });
assert(merged.ok === true, '合并拉取成功');
assert(merged.strategy === 'merge', '返回实际使用的策略');
assert(readFileSync(join(diverged, 'c.txt'), 'utf8') === 'three\n', '线上文件已合并进来');
assert(readFileSync(join(diverged, 'local-only.txt'), 'utf8') === 'mine\n', '本地提交保留');
const pushed = await git.push(diverged);
assert(pushed.ok === true, '合并后推送成功');

console.log('5. 分叉后可用变基方式拉取');
const rebased = clone('rebased');
writeFileSync(join(rebased, 'mine.txt'), 'mine\n');
run(rebased, ['add', '-A']);
run(rebased, ['commit', '-qm', 'local work']);
syncSeed();
writeFileSync(join(seed, 'd.txt'), 'four\n');
run(seed, ['add', '-A']);
run(seed, ['commit', '-qm', 'fourth']);
run(seed, ['push', '-q', 'origin', 'main']);
await git.fetchRemote(rebased);
const rebaseResult = await git.pull(rebased, { strategy: 'rebase' });
assert(rebaseResult.ok === true, '变基拉取成功');
const rebaseLog = run(rebased, ['log', '--format=%s', '-2']).trim().split('\n');
assert(rebaseLog[0] === 'local work' && rebaseLog[1] === 'fourth', '本地提交被移到线上提交之后');

console.log('6. 合并拉取冲突时返回冲突文件且不抛错');
const conflicted = clone('conflicted');
writeFileSync(join(conflicted, 'a.txt'), 'local\n');
run(conflicted, ['commit', '-qam', 'local edit']);
syncSeed();
writeFileSync(join(seed, 'a.txt'), 'remote\n');
run(seed, ['commit', '-qam', 'remote edit']);
run(seed, ['push', '-q', 'origin', 'main']);
await git.fetchRemote(conflicted);
const conflictResult = await git.pull(conflicted, { strategy: 'merge' });
assert(conflictResult.ok === false && conflictResult.reason === 'conflict', '冲突时返回 conflict');
assert(conflictResult.conflicted.includes('a.txt'), '返回冲突文件路径');
run(conflicted, ['merge', '--abort']);

console.log('7. 上游 merge 重复时返回 multiple-branches 并可修复');
const duplicated = clone('duplicated');
// 第二个 merge 目标必须在远端真实存在，git 才会报 multiple branches
run(seed, ['push', '-q', 'origin', 'main:feature']);
run(duplicated, ['config', '--add', 'branch.main.merge', 'refs/heads/feature']);
syncSeed();
writeFileSync(join(seed, 'e.txt'), 'five\n');
run(seed, ['add', '-A']);
run(seed, ['commit', '-qm', 'fifth']);
run(seed, ['push', '-q', 'origin', 'main']);
await git.fetchRemote(duplicated);
const multipleResult = await git.pull(duplicated);
assert(
  multipleResult.ok === false && multipleResult.reason === 'multiple-branches',
  '重复 merge 配置时返回 multiple-branches',
);
const repaired = await git.repairUpstream(duplicated);
assert(repaired.changed === true, '修复动作生效');
const repairedEntries = run(duplicated, ['config', '--get-all', 'branch.main.merge'])
  .trim()
  .split('\n');
assert(repairedEntries.length === 1 && repairedEntries[0] === 'refs/heads/main', '只保留指向本地分支的 merge');
const afterRepair = await git.pull(duplicated);
assert(afterRepair.ok === true, '修复后拉取成功');

console.log('8. 错误信息过滤 SSH 抗量子提示');
const noiseFree = git.cleanError(
  null,
  '** WARNING: connection is not using a post-quantum key exchange algorithm. **\n' +
    '** This session may be vulnerable to "store now, decrypt later" attacks. **\n' +
    '** The server may need to be upgraded. See https://openssh.com/pq.html **\n' +
    'fatal: unable to access repository',
);
assert(!noiseFree.includes('store now'), '过滤抗量子提示行');
assert(noiseFree === 'unable to access repository', '只保留 fatal 行内容');

console.log('9. 没有上游时返回 no-upstream');
const noUpstreamDir = mkdtempSync(join(tmpdir(), 'pull-noup-'));
run(noUpstreamDir, ['init', '-b', 'main']);
run(noUpstreamDir, ['config', 'user.email', 't@e.com']);
run(noUpstreamDir, ['config', 'user.name', 'T']);
writeFileSync(join(noUpstreamDir, 'x.txt'), 'x\n');
run(noUpstreamDir, ['add', '-A']);
run(noUpstreamDir, ['commit', '-qm', 'init']);
const noUpstreamResult = await git.pull(noUpstreamDir);
assert(noUpstreamResult.ok === false && noUpstreamResult.reason === 'no-upstream', '没有上游时返回 no-upstream');
assert(noUpstreamResult.message.includes('上游'), '没有上游时提示明确');

console.log('10. 没有远程时 fetch 静默成功');
const noRemoteResult = await git.fetchRemote(noUpstreamDir);
assert(noRemoteResult.ok === true, 'fetch 在没有远程时不报错');

console.log('11. 未发布的分支可以发布并建立上游');
const publishRepo = clone('publish');
run(publishRepo, ['checkout', '-q', '-b', 'feature']);
const beforePublish = await git.status(publishRepo);
assert(beforePublish.upstream === '', '新分支没有上游');
assert(beforePublish.remotes.includes('origin'), 'status 带出远端列表');
const publishResult = await git.push(publishRepo);
assert(publishResult.ok === true && publishResult.published === true, '发布成功');
assert(publishResult.upstream === 'origin/feature', '返回 origin/feature 作为上游');
const afterPublish = await git.status(publishRepo);
assert(afterPublish.upstream === 'origin/feature', '发布后上游已建立');
assert(
  run(base, ['rev-parse', '--verify', 'refs/heads/feature']).trim() ===
    run(publishRepo, ['rev-parse', 'HEAD']).trim(),
  '远端分支指向同一个提交',
);

console.log('12. 已发布分支再推送时 published 为 false');
writeFileSync(join(publishRepo, 'feature.txt'), 'f\n');
run(publishRepo, ['add', '-A']);
run(publishRepo, ['commit', '-qm', 'feature work']);
const republish = await git.push(publishRepo);
assert(republish.ok === true && republish.published === false, '已有上游时 published 为 false');
assert(republish.upstream === 'origin/feature', '上游保持不变');

console.log('13. 没有远端时返回 no-remote');
const noRemoteRepo = mkdtempSync(join(tmpdir(), 'publish-noremote-'));
run(noRemoteRepo, ['init', '-b', 'main']);
run(noRemoteRepo, ['config', 'user.email', 't@e.com']);
run(noRemoteRepo, ['config', 'user.name', 'T']);
run(noRemoteRepo, ['config', 'commit.gpgsign', 'false']);
writeFileSync(join(noRemoteRepo, 'x.txt'), 'x\n');
run(noRemoteRepo, ['add', '-A']);
run(noRemoteRepo, ['commit', '-qm', 'init']);
const noRemotePush = await git.push(noRemoteRepo);
assert(noRemotePush.ok === false && noRemotePush.reason === 'no-remote', '没有远端时返回 no-remote');
assert(noRemotePush.message.includes('远端'), '提示说明没有远端');

console.log('14. 多个远端时 origin 优先，没有 origin 时报错');
const multiRepo = clone('multi');
const backup = mkdtempSync(join(tmpdir(), 'publish-backup-'));
run(backup, ['init', '--bare', '-b', 'main']);
run(multiRepo, ['remote', 'add', 'upstream', backup]);
run(multiRepo, ['checkout', '-q', '-b', 'multi-feature']);
const multiPush = await git.push(multiRepo);
assert(
  multiPush.ok === true && multiPush.upstream === 'origin/multi-feature',
  '多个远端时优先 origin',
);

const ambiguousRepo = clone('ambiguous');
run(ambiguousRepo, ['remote', 'rename', 'origin', 'alpha']);
const beta = mkdtempSync(join(tmpdir(), 'publish-beta-'));
run(beta, ['init', '--bare', '-b', 'main']);
run(ambiguousRepo, ['remote', 'add', 'beta', beta]);
run(ambiguousRepo, ['checkout', '-q', '-b', 'amb-feature']);
const ambiguousPush = await git.push(ambiguousRepo);
assert(
  ambiguousPush.ok === false && ambiguousPush.reason === 'no-remote',
  '多个远端且无 origin 时返回 no-remote',
);
assert(
  ambiguousPush.message.includes('alpha') && ambiguousPush.message.includes('beta'),
  '提示列出候选远端',
);

console.log('15. 只有一个非 origin 远端时使用它');
const singleRepo = clone('single');
run(singleRepo, ['remote', 'rename', 'origin', 'only']);
run(singleRepo, ['checkout', '-q', '-b', 'only-feature']);
const singlePush = await git.push(singleRepo);
assert(
  singlePush.ok === true && singlePush.upstream === 'only/only-feature',
  '唯一远端被使用',
);

console.log('16. 游离 HEAD 返回 detached');
const detachedRepo = clone('detached');
run(detachedRepo, ['checkout', '-q', '--detach', 'HEAD']);
const detachedPush = await git.push(detachedRepo);
assert(
  detachedPush.ok === false && detachedPush.reason === 'detached',
  '游离 HEAD 返回 detached',
);

console.log(`\n全部通过：${passed} 项`);
