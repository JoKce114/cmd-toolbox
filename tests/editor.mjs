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
  page
    .locator('.git-change-item')
    .filter({ hasText: 'index.php' })
    .locator('.git-row-action'),
);
await waitFor(
  async () => (await page.locator('.tab').count()) === beforeTabs + 1,
  '新开编辑器页签',
);

await app.close();
rmSync(dataDir, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);
