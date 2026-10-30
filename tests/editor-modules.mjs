// 编辑器模块的端到端测试。
// 需要独占 17382 端口，跑之前先关掉正在运行的 Cmd Toolbox。
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-modules-'));
const projectDir = mkdtempSync(join(tmpdir(), 'cmdtb-proj-'));

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.CMDTOOLBOX_NO_UPDATE = '1';

const app = await electron.launch({
  executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
  cwd: root,
  args: ['.', `--data-dir=${dataDir}`],
  env,
});

try {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => console.log('  [pageerror]', error.message));
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.app').waitFor();
  await page.waitForTimeout(1000);

  // 窗口被遮挡时 Chromium 不投递合成的鼠标事件，确保置前
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.show();
    win?.focus();
    win?.moveTop();
  });

  await page.locator('.add-project-btn').click();
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill(projectDir);
  await page.locator('#project-name').fill('mod-proj');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await page.waitForTimeout(400);
  await page.locator('.group-item').filter({ hasText: 'mod-proj' }).locator('.group-main').click();
  await page.waitForTimeout(600);

  // 文件要在编辑器（文件树）挂载前落盘
  const messy = 'const a={x:1,y:2};\nfunction f(){if(!a.x){return 1}return 2}\n';
  writeFileSync(join(projectDir, 'sample.js'), messy, 'utf8');

  console.log('1. 打开编辑器页签');
  await page
    .locator('.group-item')
    .filter({ hasText: 'mod-proj' })
    .click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  await page.getByRole('menuitem', { name: '打开编辑器', exact: true }).click();
  await page.locator('.editor-pane').waitFor();
  assert(await page.locator('.editor-pane').isVisible(), '编辑器可见');

  console.log('2. 打开 sample.js');
  await openFile(page, 'sample.js');
  const before = await editorText(page);
  assert(before.includes('const a={x:1,y:2}'), '打开的是未格式化的原文');

  console.log('3. 右键菜单格式化文档');
  await page.locator('.cm-content').first().click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  assert(
    await page.locator('.popup-menu').getByText('格式化文档', { exact: true }).isVisible(),
    '右键菜单出现「格式化文档」',
  );
  await page.locator('.popup-menu').getByText('格式化文档', { exact: true }).click();
  await page.waitForTimeout(1500);
  const after = await editorText(page);
  assert(after.includes('const a = { x: 1, y: 2 };'), '格式化后加了空格');
  assert(after.split('\n').length > 5, `格式化后行数变多，实际 ${after.split('\n').length}`);

  console.log('4. 撤销恢复原文');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  assert((await editorText(page)) === before, 'Ctrl+Z 能撤销格式化');

  console.log(`\n全部通过（${passed} 项）`);
} finally {
  await app.close().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

// 打开文件树里的文件。项目文件树在编辑器页签挂载时就列出根目录，
// 这里只处理根目录下的文件；子目录需要先点开对应目录行。
async function openFile(page, name) {
  const entry = page.locator('.file-row').filter({ hasText: name }).first();
  await entry.waitFor({ timeout: 10000 });
  await entry.click();
  await page.locator('.cm-content').first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(600);
}

// 读编辑器全文：CodeMirror 的内容不在 textarea 里，只能从 DOM 取
async function editorText(page) {
  return page.locator('.cm-content').first().innerText();
}
