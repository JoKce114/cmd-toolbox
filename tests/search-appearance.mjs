import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const appDir = 'D:/deskTop/CmdToolbox/_ss/app';
const dataDir = mkdtempSync(join(tmpdir(), 'ss-'));
const repo = mkdtempSync(join(tmpdir(), 'ssr-'));
const shots = resolve(appDir, 'shots');
mkdirSync(shots, { recursive: true });

writeFileSync(
  join(repo, 'style.css'),
  [
    '.carousel { overflow: hidden; }',
    '.carousel * { box-sizing: border-box; }',
    '.carousel_frame { position: relative; width: 100%; }',
    '.carousel_slide { position: absolute; inset: 0; z-index: 1; }',
    '.carousel_slide_none { opacity: 0; pointer-events: none; }',
  ].join('\n'),
);
writeFileSync(
  join(repo, 'other.css'),
  ['.box { z-index: 10; }', '.panel { z-index: 20; position: relative; }'].join('\n'),
);

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
await page.locator('#project-name').fill('search-proj');
await click(page.getByRole('button', { name: '保存项目', exact: true }));
await page.locator('.modal-card').waitFor({ state: 'detached', timeout: 15000 });
await page.waitForTimeout(800);
await page.locator('.group-item').filter({ hasText: 'search-proj' }).click({ button: 'right' });
await page.locator('.popup-menu').waitFor({ timeout: 8000 });
await click(page.getByRole('menuitem', { name: '打开编辑器', exact: true }));
await page.waitForTimeout(1200);
await click(page.locator('.editor-pane .file-row').filter({ hasText: 'style.css' }));
await page.waitForTimeout(1800);

console.log('1. 项目搜索高亮');
await click(page.locator('.editor-pane .icon-btn[title*="搜索"]'));
await page.waitForTimeout(800);
await page.locator('.search-bar input').fill('z-index');
await waitFor(async () => (await page.locator('.search-hit').count()) > 0, '搜索结果出现');
const markCount = await page.locator('.search-mark').count();
ok(markCount > 0, `命中词高亮 (${markCount} 处)`);
const markBg = await page.locator('.search-mark').first().evaluate((el) => getComputedStyle(el).backgroundColor);
console.log('   高亮底色:', markBg);
ok(markBg !== 'rgba(0, 0, 0, 0)', '高亮有可见底色');
await page.screenshot({ path: join(shots, 'project-search.png') });

await page.locator('.search-bar button[title="关闭搜索"]').click();
await page.waitForTimeout(500);

console.log('2. Ctrl+F 面板中文化');
await page.locator('.editor-pane .cm-content').click();
await page.keyboard.press('Control+f');
await waitFor(async () => (await page.locator('.cm-panel.cm-search').count()) > 0, '查找面板出现');
const layout = await page.evaluate(() => {
  const panel = document.querySelector('.cm-panel.cm-search');
  const kids = [...panel.children].map((el) => {
    const r = el.getBoundingClientRect();
    return { tag: el.tagName, cls: el.className || el.name || el.type, w: Math.round(r.width), x: Math.round(r.x), y: Math.round(r.y) };
  });
  return { panelW: Math.round(panel.getBoundingClientRect().width), kids };
});
console.log('   布局:', JSON.stringify(layout, null, 1));
const panelText = await page.locator('.cm-panel.cm-search').innerText();
const placeholders = await page
  .locator('.cm-panel.cm-search input')
  .evaluateAll((els) => els.map((e) => e.placeholder));
console.log('   面板文案:', JSON.stringify(panelText.replace(/\n/g, ' | ')));
console.log('   占位符:', JSON.stringify(placeholders));
ok(placeholders.includes('查找'), '输入框占位符为中文');
ok(panelText.includes('下一个'), 'next 已中文化');
ok(panelText.includes('区分大小写'), 'match case 已中文化');
ok(!/\bFind\b|\bnext\b|\bprevious\b|\bmatch case\b/.test(panelText), '没有残留英文');
await page.screenshot({ path: join(shots, 'cm-find.png') });

console.log('3. 深色主题下的查找面板');
await page.keyboard.press('Escape');
await page.getByRole('button', { name: '深色', exact: true }).first().click();
await page.waitForTimeout(1000);
await page.locator('.editor-pane .cm-content').click();
await page.keyboard.press('Control+f');
await waitFor(async () => (await page.locator('.cm-panel.cm-search').count()) > 0, '查找面板出现');
const darkBg = await page.locator('.cm-panel.cm-search').evaluate((el) => getComputedStyle(el).backgroundColor);
console.log('   深色面板底色:', darkBg);
await page.screenshot({ path: join(shots, 'cm-find-dark.png') });

console.log(`\n全部通过：${passed} 项`);
await app.close();
