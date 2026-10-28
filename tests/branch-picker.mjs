import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'bp-'));
const repo = mkdtempSync(join(tmpdir(), 'bpr-'));
const shots = resolve(appDir, 'shots');
mkdirSync(shots, { recursive: true });

const run = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
run(['init', '-b', 'develop']);
run(['config', 'user.email', 't@e.com']);
run(['config', 'user.name', 'T']);
run(['config', 'commit.gpgsign', 'false']);
run(['config', 'core.autocrlf', 'false']);
writeFileSync(join(repo, 'a.txt'), 'a\n');
run(['add', '-A']);
run(['commit', '-qm', 'init']);
for (const branch of [
  'feature/sheldon/intelligentCache',
  'feature/sheldon/price',
  'feature/stronger/v7.0030/店铺装修',
  'feature/stronger/v7.0050/店铺配置',
  'hotfix/login',
]) {
  run(['branch', branch]);
}

let passed = 0;
const ok = (c, m) => {
  if (!c) throw new Error('断言失败：' + m);
  passed += 1;
  console.log('  ok  ' + m);
};
const waitFor = async (fn, msg, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error('等待超时：' + msg);
    await page.waitForTimeout(250);
  }
};

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
  cwd: root,
  args: ['.', `--data-dir=${dataDir}`],
  env,
});
const page = await app.firstWindow();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  w?.show();
  w?.focus();
  w?.moveTop();
  w?.setContentSize(1380, 880);
});
await page.waitForLoadState('domcontentloaded');
await page.locator('.app').waitFor({ timeout: 30000 });
await page.waitForTimeout(1500);

const click = async (loc) => {
  for (let i = 0; i < 40; i += 1) {
    try {
      await loc.click({ timeout: 2500, force: true });
      return;
    } catch {
      const b = await loc.boundingBox().catch(() => null);
      if (b) {
        await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
        return;
      }
      await page.waitForTimeout(250);
    }
  }
  throw new Error('click failed');
};

await click(page.locator('.add-project-btn'));
await page.locator('.modal-card').waitFor({ timeout: 15000 });
await page.locator('#project-path').fill(repo);
await page.locator('#project-name').fill('branch-proj');
await click(page.getByRole('button', { name: '保存项目', exact: true }));
await page.locator('.modal-card').waitFor({ state: 'detached', timeout: 15000 });
await page.waitForTimeout(1000);

console.log('1. 打开分支弹窗');
await click(page.locator('.git-branch-button'));
await waitFor(async () => (await page.locator('.branch-picker').count()) > 0, '弹窗出现');
ok(true, '分支弹窗打开');
ok(
  (await page.locator('.branch-picker-row').count()) === 6,
  '列出全部 6 个分支',
);
ok((await page.locator('.branch-picker-row.is-current').innerText()).includes('develop'), '当前分支高亮');

console.log('2. 搜索过滤');
await page.locator('.branch-picker-search input').fill('price');
await page.waitForTimeout(400);
ok((await page.locator('.branch-picker-row').count()) === 1, '搜索 price 只剩 1 条');
ok(
  (await page.locator('.branch-picker-row').innerText()).includes('feature/sheldon/price'),
  '匹配到正确分支',
);

await page.locator('.branch-picker-search input').fill('店铺');
await page.waitForTimeout(400);
ok((await page.locator('.branch-picker-row').count()) === 2, '中文搜索匹配 2 条');

await page.locator('.branch-picker-search input').fill('zzz');
await page.waitForTimeout(400);
ok((await page.locator('.branch-picker-empty').count()) === 1, '无结果时显示提示');

await page.locator('.branch-picker-search input').fill('');
await page.waitForTimeout(400);
await page.screenshot({ path: join(shots, 'branch-picker.png') });

console.log('3. 切换分支');
await page.locator('.branch-picker-search input').fill('hotfix');
await page.waitForTimeout(400);
await click(page.locator('.branch-picker-name').filter({ hasText: 'hotfix/login' }));
await waitFor(
  async () => (await page.locator('.git-branch-name').innerText()) === 'hotfix/login',
  '分支名更新',
);
ok(
  execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() ===
    'hotfix/login',
  'git 中已切换',
);

console.log(`\n全部通过：${passed} 项`);
await app.close();
