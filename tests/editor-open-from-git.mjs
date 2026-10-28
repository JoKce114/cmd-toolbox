import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const appDir = 'D:/deskTop/CmdToolbox/_ft/app';
const dataDir = mkdtempSync(join(tmpdir(), 'go-'));
const shots = resolve(appDir, 'shots');
mkdirSync(shots, { recursive: true });
const PROJECT = 'D:/git_project/develop-6.0';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
  cwd: root, args: ['.', `--data-dir=${dataDir}`], env,
});
const page = await app.firstWindow();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  w?.show(); w?.focus(); w?.moveTop(); w?.setContentSize(1380, 880);
});
await page.waitForLoadState('domcontentloaded');
await page.locator('.app').waitFor({ timeout: 30000 });
await page.waitForTimeout(1500);

let passed = 0;
const ok = (c, m) => { if (!c) throw new Error('断言失败：' + m); passed += 1; console.log('  ok  ' + m); };
const waitFor = async (fn, msg, t = 20000) => {
  const end = Date.now() + t;
  for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('等待超时：' + msg); await page.waitForTimeout(250); }
};
const click = async (loc) => {
  for (let i = 0; i < 40; i += 1) {
    try { await loc.click({ timeout: 2500, force: true }); return; }
    catch { const b = await loc.boundingBox().catch(() => null); if (b) { await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); return; } await page.waitForTimeout(250); }
  }
  throw new Error('click failed');
};

await click(page.locator('.add-project-btn'));
await page.locator('.modal-card').waitFor({ timeout: 15000 });
await page.locator('#project-path').fill(PROJECT);
await page.locator('#project-name').fill('go-proj');
await click(page.getByRole('button', { name: '保存项目', exact: true }));
await page.locator('.modal-card').waitFor({ state: 'detached', timeout: 15000 });
await page.waitForTimeout(1200);

const changedRow = page.locator('.git-change-row').first();
if ((await changedRow.count()) === 0) { console.log('没有变更，跳过'); await app.close(); process.exit(0); }
const changedName = (await changedRow.innerText()).split('\n').pop();
console.log('从 Git 打开:', changedName);

// 用 Git 面板的行内「打开文件」图标
await click(page.locator('.git-change-item').first().locator('.git-row-action[title="打开文件编辑"]'));
await waitFor(async () => (await page.locator('.editor-pane:not(.is-hidden) .cm-content').count()) > 0, '编辑器加载');
await page.waitForTimeout(1200);
const openedViaGit = await page.locator('.editor-pane:not(.is-hidden) .pane-path').innerText();
ok(openedViaGit.length > 0, `Git 打开成功: ${openedViaGit.split('/').pop()}`);

// 再点文件树里的另一个文件
// 展开 docs 目录，点里面的一个 .md 文件（确定是文件不是目录）
await click(page.locator('.editor-pane:not(.is-hidden) .file-row').filter({ hasText: 'docs' }).first());
await page.waitForTimeout(1200);
const mdRows = page.locator('.editor-pane:not(.is-hidden) .file-row').filter({ hasText: '.md' });
console.log('   .md 文件数:', await mdRows.count());
const target = mdRows.first();
const targetName = (await target.innerText()).trim();
console.log('点击文件树:', targetName);
await click(target);
await page.waitForTimeout(1800);

const afterPath = await page.locator('.editor-pane:not(.is-hidden) .pane-path').innerText();
console.log('切换后路径:', afterPath);
ok(afterPath !== openedViaGit, '点击文件树后确实切换了文件');
ok(!afterPath.includes('00-'), '没有被迫回到 Git 打开的文件');

await page.screenshot({ path: join(shots, 'git-open-then-tree.png') });
console.log(`\n全部通过：${passed} 项`);
await app.close();
