import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const appDir = 'D:/deskTop/CmdToolbox/_mi/app';
const dataDir = mkdtempSync(join(tmpdir(), 'mi-'));
const repo = mkdtempSync(join(tmpdir(), 'mir-'));
const shots = resolve(appDir, 'shots');
mkdirSync(shots, { recursive: true });

const run = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
run(['init', '-b', 'develop']);
run(['config', 'user.email', 't@e.com']);
run(['config', 'user.name', 'T']);
run(['config', 'commit.gpgsign', 'false']);
run(['config', 'core.autocrlf', 'false']);
writeFileSync(join(repo, 'base.txt'), 'base\n');
run(['add', '-A']);
run(['commit', '-qm', 'init']);
run(['branch', 'main']);
run(['checkout', '-q', '-b', 'feature']);
writeFileSync(join(repo, 'feature.txt'), 'from feature\n');
run(['add', '-A']);
run(['commit', '-qm', 'feature work']);
run(['checkout', '-q', 'main']);

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
const head = () => execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

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
await page.locator('#project-name').fill('merge-proj');
await click(page.getByRole('button', { name: '保存项目', exact: true }));
await page.locator('.modal-card').waitFor({ state: 'detached', timeout: 15000 });
await page.waitForTimeout(1200);

console.log('1. 打开合并弹窗');
await click(page.locator('.git-branch-button'));
await waitFor(async () => (await page.locator('.branch-picker').count()) > 0, '分支弹窗');
await click(page.getByRole('button', { name: '合并分支…', exact: true }));
await waitFor(async () => (await page.locator('.merge-arrow').count()) > 0, '合并弹窗出现');
ok(true, '合并弹窗打开');

const triggers = page.locator('.branch-select-trigger');
ok((await triggers.count()) === 2, '有源分支和目标分支两个下拉');

console.log('2. 默认值与提示');
ok((await triggers.nth(1).innerText()).includes('main'), '目标默认当前分支 main');
ok((await triggers.nth(1).innerText()).includes('当前'), '目标标记为当前分支');
ok(
  (await page.locator('.merge-hint').count()) === 0,
  '目标是当前分支时不显示切换提示',
);

console.log('3. 选非当前目标时出现提示');
// 仓库当前在 main，选 develop 才是「非当前目标」
await click(triggers.nth(1));
await page.locator('.branch-select-popup').waitFor({ timeout: 5000 });
const opts = page.locator('.branch-select-popup .branch-select-option');
await opts.filter({ hasText: 'develop' }).first().click();
await page.waitForTimeout(500);
ok((await triggers.nth(1).innerText()).includes('develop'), '目标已改为 develop');
ok((await page.locator('.merge-hint').count()) === 1, '提示会切换分支');

await page.screenshot({ path: join(shots, 'merge-modal.png') });

console.log('4. 执行合并');
await click(triggers.nth(0));
await page.locator('.branch-select-option').filter({ hasText: 'feature' }).first().click();
await click(triggers.nth(1));
await page.locator('.branch-select-option').filter({ hasText: 'main' }).first().click();
await page.waitForTimeout(300);
await click(page.getByRole('button', { name: '开始合并', exact: true }));
await waitFor(
  async () => (await page.locator('.toast').allInnerTexts()).some((t) => t.includes('已把')),
  '出现成功提示',
);
ok(true, '合并成功提示');

run(['checkout', '-q', 'main']);
ok(
  readFileSync(join(repo, 'feature.txt'), 'utf8') === 'from feature\n',
  'main 已包含 feature 的内容',
);
run(['checkout', '-q', 'develop']);

console.log('5. 源和目标不会撞车');
await click(page.locator('.git-branch-button'));
await waitFor(async () => (await page.locator('.branch-picker').count()) > 0, '分支弹窗');
await click(page.getByRole('button', { name: '合并分支…', exact: true }));
await waitFor(async () => (await page.locator('.merge-arrow').count()) > 0, '合并弹窗');
const s2 = page.locator('.branch-select-trigger');
// 把目标选成当前的源分支，源应自动让开
const sourceBefore = await s2.nth(0).innerText();
await click(s2.nth(1));
await page.locator('.branch-select-popup .branch-select-option').filter({ hasText: sourceBefore }).first().click();
await page.waitForTimeout(400);
const sourceAfter = await s2.nth(0).innerText();
ok(!sourceAfter.includes(sourceBefore), '目标选中源分支时，源自动让开');
ok((await page.locator('.merge-warning').count()) === 0, '不再出现相同警告');
ok(
  await page.getByRole('button', { name: '开始合并', exact: true }).isEnabled(),
  '自动避让后按钮可用',
);

console.log(`\n全部通过：${passed} 项`);
await app.close();
