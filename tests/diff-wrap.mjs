import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'dw-'));
const repo = mkdtempSync(join(tmpdir(), 'dwr-'));
const shots = resolve(appDir, 'shots');
mkdirSync(shots, { recursive: true });

const run = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
run(['init', '-b', 'main']);
run(['config', 'user.email', 't@e.com']);
run(['config', 'user.name', 'T']);
run(['config', 'commit.gpgsign', 'false']);
run(['config', 'core.autocrlf', 'false']);

const longLine =
  '.poster_mode_323 .poster_item{position:relative;min-width:0;overflow:hidden;border-radius:16px;background:#DDDDDD;text-decoration:none}';
writeFileSync(join(repo, 'main.css'), '.a{color:red}\n');
run(['add', '-A']);
run(['commit', '-qm', 'init']);
writeFileSync(join(repo, 'main.css'), `.a{color:red}\n${longLine}\n`);

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
await page.locator('#project-name').fill('wrap-proj');
await click(page.getByRole('button', { name: '保存项目', exact: true }));
await page.locator('.modal-card').waitFor({ state: 'detached', timeout: 15000 });
await page.waitForTimeout(1200);

console.log('1. 打开 diff 视图');
await click(page.locator('.git-change-row').filter({ hasText: 'main.css' }));
await waitFor(async () => (await page.locator('.diff-body').count()) > 0, 'diff 视图');
ok(true, 'diff 视图打开');

const readScroll = async () =>
  page.evaluate(() => {
    const body = document.querySelector('.diff-body');
    const wrapped = body?.classList.contains('is-wrapped') ?? false;
    const row = document.querySelector('.diff-row');
    return {
      wrapped,
      scrollW: body?.scrollWidth ?? 0,
      clientW: body?.clientWidth ?? 0,
      rowH: row ? Math.round(row.getBoundingClientRect().height) : 0,
      whiteSpace: row ? getComputedStyle(row).whiteSpace : '',
    };
  });

console.log('2. 默认（换行开）');
const on = await readScroll();
console.log('   ', JSON.stringify(on));
ok(on.wrapped === true, '带 is-wrapped 类');
ok(on.scrollW <= on.clientW + 2, '没有横向溢出');
await page.screenshot({ path: join(shots, 'diff-wrap-on.png') });

console.log('3. 关闭自动换行');
await click(page.locator('.titlebar-settings'));
await waitFor(async () => (await page.locator('.settings-body').count()) > 0, '设置面板');
await click(page.locator('.settings-item').filter({ hasText: '自动换行' }).locator('.settings-switch'));
await page.waitForTimeout(300);
await click(page.getByRole('button', { name: '保存', exact: true }));
await page.waitForTimeout(1200);

const off = await readScroll();
console.log('   ', JSON.stringify(off));
ok(off.wrapped === false, '不带 is-wrapped 类');
ok(off.scrollW > off.clientW, '长行横向溢出');
await page.screenshot({ path: join(shots, 'diff-wrap-off.png') });

console.log(`\n全部通过：${passed} 项`);
await app.close();
