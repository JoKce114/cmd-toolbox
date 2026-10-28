import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'gf-'));
const repo = mkdtempSync(join(tmpdir(), 'gfr-'));
const shots = resolve(root, 'test-shots');
mkdirSync(shots, { recursive: true });

const run = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
run(['init', '-b', 'main']);
run(['config', 'user.email', 't@e.com']);
run(['config', 'user.name', 'T']);
run(['config', 'commit.gpgsign', 'false']);
run(['config', 'core.autocrlf', 'false']);
mkdirSync(join(repo, 'src'));
writeFileSync(join(repo, 'src', 'alpha.js'), 'const alpha = 1;\n');
writeFileSync(join(repo, 'src', 'beta.js'), 'const beta = 2;\n');
writeFileSync(join(repo, 'readme.md'), '# readme\n');
run(['add', '-A']);
run(['commit', '-qm', 'init']);
// 制造两个变更
writeFileSync(join(repo, 'src', 'alpha.js'), 'const alpha = 111;\n');
writeFileSync(join(repo, 'src', 'beta.js'), 'const beta = 222;\n');

let passed = 0;
const ok = (c, m) => {
  if (!c) throw new Error('断言失败：' + m);
  passed += 1;
  console.log('  ok  ' + m);
};
const waitFor = async (fn, msg, t = 20000) => {
  const end = Date.now() + t;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error('等待超时：' + msg);
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
await page.locator('#project-name').fill('gf-proj');
await click(page.getByRole('button', { name: '保存项目', exact: true }));
await page.locator('.modal-card').waitFor({ state: 'detached', timeout: 15000 });
await page.waitForTimeout(1200);

const editorPath = () =>
  page.locator('.editor-pane:not(.is-hidden) .pane-path').first().innerText().catch(() => '');

console.log('1. 无编辑器页签时，点 Git 行内「打开文件编辑」');
await click(
  page.locator('.git-change-item').filter({ hasText: 'alpha.js' }).locator('.git-row-action[title="打开文件编辑"]'),
);
await waitFor(async () => (await page.locator('.editor-pane').count()) > 0, '编辑器页签出现');
await page.waitForTimeout(1500);
const first = await editorPath();
console.log('   打开路径:', first);
ok(first.includes('alpha.js'), '打开了 alpha.js');
await page.screenshot({ path: join(shots, 'from-git-1.png') });

console.log('2. 已有编辑器时，点另一个文件的图标');
const tabsBefore = await page.locator('.tab').count();
await click(
  page.locator('.git-change-item').filter({ hasText: 'beta.js' }).locator('.git-row-action[title="打开文件编辑"]'),
);
await page.waitForTimeout(1800);
const tabsAfter = await page.locator('.tab').count();
const second = await editorPath();
console.log('   打开路径:', second, '| 页签数:', tabsBefore, '→', tabsAfter);
ok(second.includes('beta.js'), '打开了 beta.js');

console.log('3. 点变更行 → diff → 点「打开文件」');
await click(page.locator('.git-change-item').filter({ hasText: 'alpha.js' }).locator('.git-change-row'));
await waitFor(async () => (await page.locator('.diff-pane:not(.is-hidden)').count()) > 0, 'diff 视图');
ok(true, 'diff 视图打开');
await click(page.locator('.diff-pane:not(.is-hidden) .diff-open-file'));
await page.waitForTimeout(1800);
const third = await page.locator('.editor-pane:not(.is-hidden) .pane-path').first().innerText().catch(() => '');
console.log('   打开路径:', third);
ok(third.includes('alpha.js'), '从 diff 打开了 alpha.js');
await page.screenshot({ path: join(shots, 'from-git-3.png') });

console.log(`\n全部通过：${passed} 项`);
await app.close();
