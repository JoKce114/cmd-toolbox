import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const iconv = require('iconv-lite');

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-data-'));
const repo = mkdtempSync(join(tmpdir(), 'cmdtb-edit-'));

mkdirSync(join(repo, 'src'));
writeFileSync(join(repo, 'index.php'), '<?php echo 1;\n');
writeFileSync(join(repo, 'src', 'app.js'), 'console.log(1);\n');
writeFileSync(join(repo, 'gbk.txt'), iconv.encode('中文内容\n', 'gbk'));
writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
writeFileSync(join(repo, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 10));
writeFileSync(
  join(repo, 'utf16.txt'),
  Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode('UTF-16 内容\n', 'utf-16-le')]),
);

// 步骤 7 依赖 Git 面板列出变更，临时目录需要先初始化仓库
execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });

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
page.on('pageerror', (error) => console.log('  [pageerror]', error.message));
await page.waitForLoadState('domcontentloaded');
await page.locator('.app').waitFor();
await page.waitForFunction(() => !document.querySelector('.boot-screen'));
await page.waitForTimeout(1000);

// 若窗口被其他程序遮挡，Chromium 不会投递合成的鼠标事件；确保窗口置于最前
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0];
  win?.show();
  win?.focus();
  win?.moveTop();
});

async function click(locator) {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      await locator.click({ timeout: 3000, force: true });
      return;
    } catch (error) {
      const box = await locator.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return;
      }
      if (Date.now() > deadline) throw error;
      await page.waitForTimeout(300);
    }
  }
}

async function waitFor(predicate, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${message}`);
    await page.waitForTimeout(250);
  }
}

console.log('1. 打开编辑器页签');
await click(page.locator('.add-project-btn'));
await waitFor(async () => (await page.locator('.modal-card').count()) > 0, '添加项目弹窗');
await page.locator('#project-path').fill(repo);
await page.locator('#project-name').fill('edit-proj');
await click(page.getByRole('button', { name: '保存项目', exact: true }));
await page.locator('.modal-card').waitFor({ state: 'detached', timeout: 15000 });
await page.waitForTimeout(400);

await click(page.locator('.group-item').filter({ hasText: 'edit-proj' }).locator('.group-main'));
await page.waitForTimeout(600);
await page.locator('.group-item').filter({ hasText: 'edit-proj' }).click({ button: 'right' });
await page.locator('.popup-menu').waitFor({ timeout: 8000 });
await click(page.getByRole('menuitem', { name: '打开编辑器', exact: true }));
await waitFor(async () => (await page.locator('.editor-pane').count()) > 0, '编辑器页签出现');
assert(await page.locator('.editor-pane').isVisible(), '编辑器可见');

console.log('2. 文件树');
await waitFor(
  async () => (await page.locator('.file-row').filter({ hasText: 'index.php' }).count()) > 0,
  '文件树列出 index.php',
);
assert(
  await page.locator('.file-row').filter({ hasText: 'src' }).isVisible(),
  '文件树列出 src 目录',
);
assert(
  (await page.locator('.file-row').filter({ hasText: 'node_modules' }).count()) === 0,
  '不列出 node_modules',
);

console.log('3. 展开目录');
await click(page.locator('.file-row').filter({ hasText: 'src' }));
await waitFor(
  async () => (await page.locator('.file-row').filter({ hasText: 'app.js' }).count()) > 0,
  '展开后列出 app.js',
);

console.log('4. 打开并编辑保存');
await click(page.locator('.file-row').filter({ hasText: 'index.php' }));
await waitFor(async () => (await page.locator('.cm-content').count()) > 0, '编辑器加载');
assert(
  (await page.locator('.cm-content').innerText()).includes('echo 1'),
  '显示文件内容',
);
assert((await page.locator('.editor-encoding').innerText()) === 'UTF-8', '显示编码 UTF-8');

await page.locator('.cm-content').click();
await page.keyboard.press('Control+A');
await page.keyboard.type('<?php echo 99;\n');
await waitFor(
  async () => (await page.locator('.tab.active .tab-func').innerText()).includes('•'),
  '标题出现未保存标记',
);
await page.keyboard.press('Control+S');
await waitFor(
  async () => !(await page.locator('.tab.active .tab-func').innerText()).includes('•'),
  '保存后未保存标记消失',
);
assert(readFileSync(join(repo, 'index.php'), 'utf8') === '<?php echo 99;\n', '磁盘内容已更新');

console.log('5. GBK 文件保存后编码不变');
await click(page.locator('.file-row').filter({ hasText: 'gbk.txt' }));
await waitFor(async () => (await page.locator('.cm-content').count()) > 0, 'GBK 文件加载');
assert((await page.locator('.editor-encoding').innerText()) === 'GBK', '识别 GBK');
assert((await page.locator('.cm-content').innerText()).includes('中文内容'), 'GBK 中文正常显示');
await page.locator('.cm-content').click();
await page.keyboard.press('Control+A');
await page.keyboard.type('新的内容\n');
await page.keyboard.press('Control+S');
await page.waitForTimeout(1200);
const gbkAfter = readFileSync(join(repo, 'gbk.txt'));
assert(Buffer.compare(gbkAfter, iconv.encode('新的内容\n', 'gbk')) === 0, 'GBK 原样写回');

console.log('6. 二进制只读');
await click(page.locator('.file-row').filter({ hasText: 'bin.dat' }));
await waitFor(async () => (await page.locator('.editor-notice').count()) > 0, '只读提示出现');
assert(
  await page.getByRole('button', { name: '保存 (Ctrl+S)' }).isDisabled(),
  '只读文件保存按钮禁用',
);

console.log('7. Git 面板用编辑器打开');
writeFileSync(join(repo, 'index.php'), '<?php echo 100;\n');
await page.waitForTimeout(1500);
await click(page.locator('.git-icon-btn'));
await waitFor(
  async () => (await page.locator('.git-change-row').filter({ hasText: 'index.php' }).count()) > 0,
  'Git 面板列出变更',
);
const beforeTabs = await page.locator('.tab').count();
await click(
  page.locator('.git-change-item').filter({ hasText: 'index.php' }).locator('.git-change-row'),
);
await waitFor(
  async () => (await page.locator('.tab').count()) === beforeTabs + 1,
  '新开编辑器页签',
);

// 切回最初的空编辑器页签（未绑定 filePath，文件树可以自由切换）
await click(page.locator('.tab').first());
await page.waitForTimeout(400);
const activePane = page.locator('.editor-pane:not(.is-hidden)');

console.log('8. 关闭脏页签需确认');
await click(activePane.locator('.file-row').filter({ hasText: 'index.php' }));
await waitFor(
  async () => (await activePane.locator('.cm-content').count()) > 0,
  'index.php 在编辑器加载',
);
await activePane.locator('.cm-content').click();
await page.keyboard.press('Control+A');
await page.keyboard.type('未保存内容\n');
await waitFor(
  async () => (await page.locator('.tab.active .tab-func').innerText()).includes('•'),
  '脏标记出现',
);
const tabsBeforeClose = await page.locator('.tab').count();
let closeConfirm = '';
page.once('dialog', async (dialog) => {
  closeConfirm = dialog.message();
  await dialog.dismiss();
});
await click(page.locator('.tab.active .tab-close'));
await page.waitForTimeout(500);
assert(closeConfirm.includes('未保存'), '关闭脏页签弹出确认');
assert(
  (await page.locator('.tab').count()) === tabsBeforeClose,
  '拒绝关闭后页签保留',
);
// 重新聚焦编辑区并保存，恢复干净状态供后续用例使用
await activePane.locator('.cm-content').click();
await page.keyboard.press('Control+S');
await waitFor(
  async () => !(await page.locator('.tab.active .tab-func').innerText()).includes('•'),
  '保存后脏标记消失',
);
assert(readFileSync(join(repo, 'index.php'), 'utf8') === '未保存内容\n', '确认框取消后仍可正常保存');

console.log('9. 超过 2MB 的文件只读');
await click(activePane.locator('.file-row').filter({ hasText: 'big.txt' }));
await waitFor(
  async () => (await activePane.locator('.editor-notice').count()) > 0,
  '大文件只读提示',
);
assert(
  await activePane.getByRole('button', { name: '保存 (Ctrl+S)' }).isDisabled(),
  '大文件保存按钮禁用',
);

console.log('10. UTF-16LE 带 BOM 可编辑');
await click(activePane.locator('.file-row').filter({ hasText: 'utf16.txt' }));
await waitFor(
  async () =>
    (await activePane.locator('.cm-content').count()) > 0 &&
    (await activePane.locator('.cm-content').innerText()).includes('UTF-16 内容'),
  'UTF-16 内容显示',
);
assert(
  (await activePane.locator('.editor-encoding').innerText()) === 'UTF-16 LE',
  '识别 UTF-16 LE',
);
assert(
  (await activePane.locator('.editor-notice').count()) === 0,
  'UTF-16 文件可编辑（非只读）',
);
await activePane.locator('.cm-content').click();
await page.keyboard.press('Control+A');
await page.keyboard.type('UTF-16 新内容\n');
await page.keyboard.press('Control+S');
await page.waitForTimeout(1200);
const utf16After = readFileSync(join(repo, 'utf16.txt'));
const utf16Expected = Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  iconv.encode('UTF-16 新内容\n', 'utf-16-le'),
]);
assert(Buffer.compare(utf16After, utf16Expected) === 0, 'UTF-16 按原编码写回');

await app.close();
rmSync(dataDir, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);
