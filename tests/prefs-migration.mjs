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

// 写旧值 → 重新加载 → 打开设置 → （可选）切页签
const seedAndOpenSettings = async (stored, tabName) => {
  await page.evaluate((value) => {
    localStorage.setItem('cmd-toolbox.prefs', JSON.stringify(value));
  }, stored);
  await page.reload();
  await page.locator('.app').waitFor({ timeout: 30000 });
  await page.waitForTimeout(1200);
  await click(page.locator('.titlebar-settings'));
  await waitFor(async () => (await page.locator('.settings-body').count()) > 0, '设置面板');
  if (tabName) {
    await click(page.getByRole('tab', { name: tabName }));
    await page.waitForTimeout(300);
  }
};

const terminalFontEm = async () =>
  (
    await page
      .locator('.settings-item')
      .filter({ hasText: '终端字号' })
      .locator('em')
      .innerText()
  ).trim();

// 设置面板的「保存」会把 readPrefs 归一化后的完整 prefs 写回 localStorage，
// 借此直接断言迁移/舍入/兜底结果（新字段在 Task 1 还没有对应控件）。
const saveAndReadPrefs = async () => {
  await click(page.getByRole('button', { name: '保存' }));
  await page.waitForTimeout(400);
  return page.evaluate(() => JSON.parse(localStorage.getItem('cmd-toolbox.prefs') || '{}'));
};

console.log('1. 写入旧版 prefs（只有 fontSize）并重新加载');
await seedAndOpenSettings({
  fontSize: 18,
  copyOnSelect: true,
  editorWordWrap: true,
  editorTabSize: 4,
});
await click(page.getByRole('tab', { name: '终端' }));
await page.waitForTimeout(300);

console.log('2. 终端页签显示迁移后的字号');
const sliderValue = await page
  .locator('.settings-item')
  .filter({ hasText: '终端字号' })
  .locator('input[type="range"]')
  .inputValue();
ok(sliderValue === '18', '旧字段 fontSize 迁移为 terminalFontSize');
ok((await terminalFontEm()) === '18px', '终端字号显示 18px');

console.log('3. 越界与非法的旧值被夹到合法范围');
await seedAndOpenSettings({ fontSize: 999 }, '终端');
const clamped = await terminalFontEm();
ok(clamped === '20px', '越界字号被夹到上限 20，实际 ' + clamped);

console.log('4. 行高舍入到两位小数、字体族兜底、开关显式值');
await seedAndOpenSettings(
  {
    editorLineHeight: 1.2000000000000002,
    editorFontFamily: 'bogus',
    editorLineNumbers: false,
    editorShowWhitespace: true,
  },
  '编辑器',
);
const explicit = await saveAndReadPrefs();
ok(explicit.editorLineHeight === 1.2, '行高 1.2000000000000002 舍入为 1.2，实际 ' + explicit.editorLineHeight);
ok(explicit.editorFontFamily === 'consolas', '非法字体族兜底为 consolas，实际 ' + explicit.editorFontFamily);
ok(explicit.editorLineNumbers === false, 'editorLineNumbers 显式 false 保持 false');
ok(explicit.editorShowWhitespace === true, 'editorShowWhitespace 显式 true 保持 true');

console.log('5. 未存过的字段使用默认值');
await seedAndOpenSettings({}, '编辑器');
const defaults = await saveAndReadPrefs();
ok(defaults.editorLineHeight === 1.5, '行高默认 1.5，实际 ' + defaults.editorLineHeight);
ok(defaults.editorFontFamily === 'consolas', '字体族默认 consolas');
ok(defaults.editorLineNumbers === true, 'editorLineNumbers 默认 true');
ok(defaults.editorShowWhitespace === false, 'editorShowWhitespace 默认 false');
ok(defaults.editorFontSize === 13, '编辑器字号默认 13');
ok(defaults.terminalFontSize === 13, '终端字号默认 13');

console.log(`\n全部通过：${passed} 项`);
await app.close();
