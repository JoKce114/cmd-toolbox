import { _electron as electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'prefs-'));

let passed = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error('断言失败：' + msg);
  passed += 1;
  console.log('  ok  ' + msg);
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
env.CMDTOOLBOX_NO_UPDATE = '1';
const app = await electron.launch({
  executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
  cwd: root,
  args: ['.', `--data-dir=${dataDir}`],
  env,
});
const page = await app.firstWindow();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.waitForLoadState('domcontentloaded');
await page.locator('.app').waitFor({ timeout: 30000 });
await page.waitForTimeout(1200);

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

console.log('1. 写入旧版 prefs（只有 fontSize）并重新加载');
await page.evaluate(() => {
  localStorage.setItem(
    'cmd-toolbox.prefs',
    JSON.stringify({ fontSize: 18, copyOnSelect: true, editorWordWrap: true, editorTabSize: 4 }),
  );
});
await page.reload();
await page.locator('.app').waitFor({ timeout: 30000 });
await page.waitForTimeout(1200);

console.log('2. 终端页签显示迁移后的字号');
await click(page.locator('.titlebar-settings'));
await waitFor(async () => (await page.locator('.settings-body').count()) > 0, '设置面板');
await click(page.getByRole('tab', { name: '终端' }));
await page.waitForTimeout(300);

const sliderValue = await page
  .locator('.settings-item')
  .filter({ hasText: '终端字号' })
  .locator('input[type="range"]')
  .inputValue();
ok(sliderValue === '18', '旧字段 fontSize 迁移为 terminalFontSize');

const label = await page
  .locator('.settings-item')
  .filter({ hasText: '终端字号' })
  .locator('em')
  .innerText();
ok(label.trim() === '18px', '终端字号显示 18px');

console.log('3. 越界与非法的旧值被夹到合法范围');
await page.evaluate(() => {
  localStorage.setItem('cmd-toolbox.prefs', JSON.stringify({ fontSize: 999 }));
});
await page.reload();
await page.locator('.app').waitFor({ timeout: 30000 });
await page.waitForTimeout(1200);
await click(page.locator('.titlebar-settings'));
await waitFor(async () => (await page.locator('.settings-body').count()) > 0, '设置面板');
await click(page.getByRole('tab', { name: '终端' }));
await page.waitForTimeout(300);
const clamped = await page
  .locator('.settings-item')
  .filter({ hasText: '终端字号' })
  .locator('input[type="range"]')
  .inputValue();
ok(clamped === '20', '越界字号被夹到上限 20，实际 ' + clamped);

console.log(`\n全部通过：${passed} 项`);
await app.close();
