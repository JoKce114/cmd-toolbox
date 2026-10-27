import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-data-'));
const repo = mkdtempSync(join(tmpdir(), 'cmdtb-ipc-'));
execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
writeFileSync(join(repo, 'a.txt'), 'a\n');
const plain = mkdtempSync(join(tmpdir(), 'cmdtb-plain-'));

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
  cwd: root,
  args: ['.', `--data-dir=${dataDir}`],
  env,
});
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.locator('.app').waitFor();
await page.waitForTimeout(1200);

// 先把两个目录保存为项目，IPC 白名单才放行
await page.evaluate(
  async ([repoPath, plainPath]) => {
    await window.api.projects.save({ name: 'ipc-repo', path: repoPath });
    await window.api.projects.save({ name: 'ipc-plain', path: plainPath });
  },
  [repo, plain],
);

const status = await page.evaluate((p) => window.api.git.status(p), repo);
assert(status.ok === true, '已保存的仓库返回状态');
assert(status.branch === 'main', '分支名正确');
assert(status.changes.length === 1, '变更数量正确');

const notRepo = await page.evaluate((p) => window.api.git.status(p), plain);
assert(notRepo.ok === false && notRepo.reason === 'not-repo', '非仓库返回 not-repo');

// 已保存的项目目录被删除后，status 应报 missing-dir 而不是被白名单拒绝
const vanished = mkdtempSync(join(tmpdir(), 'cmdtb-vanish-'));
await page.evaluate((p) => window.api.projects.save({ name: 'ipc-vanish', path: p }), vanished);
rmSync(vanished, { recursive: true, force: true });
const missing = await page.evaluate((p) => window.api.git.status(p), vanished);
assert(missing.ok === false && missing.reason === 'missing-dir', '缺失目录返回 missing-dir');

let blocked = '';
try {
  await page.evaluate(() => window.api.git.status('C:\\Windows'));
} catch (error) {
  blocked = error.message;
}
assert(blocked.includes('未保存'), '未保存路径被白名单拒绝');

let subBlocked = '';
try {
  await page.evaluate((p) => window.api.git.status(`${p}\\\\sub`), repo);
} catch (error) {
  subBlocked = error.message;
}
assert(subBlocked.includes('未保存'), '项目子目录也被白名单拒绝');

const diff = await page.evaluate((p) => window.api.git.diff(p, 'a.txt', 'untracked'), repo);
assert(diff.command.includes('--no-index'), 'diff 命令可获取');

await app.close();
rmSync(dataDir, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);
