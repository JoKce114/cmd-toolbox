import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'st-'));
const repo = mkdtempSync(join(tmpdir(), 'str-'));
const shots = resolve(appDir, 'shots');
mkdirSync(shots, { recursive: true });

const longLine = 'const value = "' + 'x'.repeat(220) + '";\n';
writeFileSync(join(repo, 'long.js'), '// wrap test\n' + longLine);

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

console.log('1. 打开设置');
await click(page.getByRole('button', { name: '设置', exact: true }).or(page.locator('.titlebar-settings')));
await waitFor(async () => (await page.locator('.settings-body').count()) > 0, '设置面板');
ok(true, '设置面板打开');
ok((await page.locator('.settings-group').count()) === 2, '分为终端和编辑器两组');
await page.screenshot({ path: join(shots, 'settings.png') });

console.log('2. 自动换行开关');
const wrapSwitch = page.locator('.settings-item').filter({ hasText: '自动换行' }).locator('.settings-switch');
ok((await wrapSwitch.getAttribute('aria-checked')) === 'true', '默认开启');
await click(wrapSwitch);
await page.waitForTimeout(300);
ok((await wrapSwitch.getAttribute('aria-checked')) === 'false', '点击后关闭');
await click(wrapSwitch);
await page.waitForTimeout(300);

console.log('3. 保存并验证编辑器换行');
await click(page.getByRole('button', { name: '保存', exact: true }));
await page.waitForTimeout(600);

await click(page.locator('.add-project-btn'));
await page.locator('.modal-card').waitFor({ timeout: 15000 });
await page.locator('#project-path').fill(repo);
await page.locator('#project-name').fill('wrap-proj');
await click(page.getByRole('button', { name: '保存项目', exact: true }));
await page.locator('.modal-card').waitFor({ state: 'detached', timeout: 15000 });
await page.waitForTimeout(800);
await page.locator('.group-item').filter({ hasText: 'wrap-proj' }).click({ button: 'right' });
await page.locator('.popup-menu').waitFor({ timeout: 8000 });
await click(page.getByRole('menuitem', { name: '打开编辑器', exact: true }));
await page.waitForTimeout(1200);
await click(page.locator('.editor-pane .file-row').filter({ hasText: 'long.js' }));
await page.waitForTimeout(2000);

const wrapOn = await page.evaluate(() => {
  const content = document.querySelector('.cm-content');
  const scroller = document.querySelector('.cm-scroller');
  return {
    hasWrapping: content?.classList.contains('cm-lineWrapping') ?? false,
    scrollW: scroller?.scrollWidth ?? 0,
    clientW: scroller?.clientWidth ?? 0,
  };
});
console.log('   换行开:', JSON.stringify(wrapOn));
ok(wrapOn.hasWrapping || wrapOn.scrollW <= wrapOn.clientW + 2, '开启时内容不横向溢出');

// 关掉换行
await click(page.locator('.titlebar-settings'));
await waitFor(async () => (await page.locator('.settings-body').count()) > 0, '设置面板');
await click(page.locator('.settings-item').filter({ hasText: '自动换行' }).locator('.settings-switch'));
await page.waitForTimeout(300);
await click(page.getByRole('button', { name: '保存', exact: true }));
await page.waitForTimeout(1200);

const wrapOff = await page.evaluate(() => {
  const content = document.querySelector('.cm-content');
  const scroller = document.querySelector('.cm-scroller');
  return {
    hasWrapping: content?.classList.contains('cm-lineWrapping') ?? false,
    scrollW: scroller?.scrollWidth ?? 0,
    clientW: scroller?.clientWidth ?? 0,
  };
});
console.log('   换行关:', JSON.stringify(wrapOff));
ok(wrapOff.scrollW > wrapOff.clientW, '关闭后长行横向溢出');

await page.screenshot({ path: join(shots, 'nowrap.png') });
console.log(`\n全部通过：${passed} 项`);
await app.close();
