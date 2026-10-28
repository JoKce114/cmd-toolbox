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

console.log('3. 分叉时拒绝快进并给出提示');
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
let divergedError = '';
try {
  await git.pull(diverged);
} catch (error) {
  divergedError = error.message;
}
assert(divergedError.includes('分叉'), '分叉时提示本地与线上已分叉');
assert(divergedError.includes('终端'), '提示去终端处理');

console.log('4. 没有上游时拒绝拉取');
const noUpstreamDir = mkdtempSync(join(tmpdir(), 'pull-noup-'));
run(noUpstreamDir, ['init', '-b', 'main']);
run(noUpstreamDir, ['config', 'user.email', 't@e.com']);
run(noUpstreamDir, ['config', 'user.name', 'T']);
writeFileSync(join(noUpstreamDir, 'x.txt'), 'x\n');
run(noUpstreamDir, ['add', '-A']);
run(noUpstreamDir, ['commit', '-qm', 'init']);
let noUpstreamError = '';
try {
  await git.pull(noUpstreamDir);
} catch (error) {
  noUpstreamError = error.message;
}
assert(noUpstreamError.includes('上游'), '没有上游时提示明确');

console.log('5. 没有远程时 fetch 静默成功');
const noRemoteResult = await git.fetchRemote(noUpstreamDir);
assert(noRemoteResult.ok === true, 'fetch 在没有远程时不报错');

console.log(`\n全部通过：${passed} 项`);
