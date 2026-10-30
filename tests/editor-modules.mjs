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

// 文件必须在编辑器页签挂载（文件树首次列目录）之前落盘
const messy = 'const a={x:1,y:2};\nfunction f(){if(!a.x){return 1}return 2}\n';
writeFileSync(join(projectDir, 'sample.js'), messy, 'utf8');

// 选区格式化：只动中间两行，首尾两行必须原样保留
writeFileSync(
  join(projectDir, 'selection.js'),
  [
    'var untouchedA={a:1,b:2};',
    'var target={x:1,y:2};',
    'function g(){if(!target.x){return 1}return 2}',
    'var untouchedB={c:3,d:4};',
    '',
  ].join('\n'),
  'utf8',
);

// 竞态测试：首次格式化要现下载 typescript 插件 chunk，await 窗口最大。
// 文件保持较小，innerText 才能取到全文（大文档会被虚拟化，只渲染视口行）。
const raceLines = [];
for (let i = 0; i < 12; i += 1) {
  raceLines.push(`const v${i}={a:${i},b:${i + 1}};`);
  raceLines.push(`function f${i}(){if(!v${i}.a){return ${i}}return ${i + 1}}`);
}
writeFileSync(join(projectDir, 'race.ts'), `${raceLines.join('\n')}\n`, 'utf8');

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

  console.log('1. 打开编辑器页签');
  await page
    .locator('.group-item')
    .filter({ hasText: 'mod-proj' })
    .click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  await page.getByRole('menuitem', { name: '打开编辑器', exact: true }).click();
  await page.locator('.editor-pane').waitFor();
  assert(await page.locator('.editor-pane').isVisible(), '编辑器可见');

  // 放在所有格式化之前：这是本测试第一次触发格式化，typescript 插件 chunk
  // 还没加载，await 窗口最大。
  // 注入方式：React 的 onClick 挂在根容器上，window 上的冒泡监听器在它之后执行，
  // 此时格式化已进入 await；用一次 paste 事件把「用户输入」同步写进编辑器。
  // 这个时序是确定的：动态 import 不可能在当前事件任务内完成。
  console.log('2. 竞态：格式化期间的用户输入不能被覆盖');
  await openFile(page, 'race.ts');
  const raceBefore = await editorText(page);
  assert(raceBefore.includes('const v0={a:0,b:1};'), '打开的是未格式化的原文');
  await page.locator('.cm-content').first().click();
  await page.evaluate(() => {
    const handler = (event) => {
      const button = event.target instanceof Element ? event.target.closest('.popup-item') : null;
      if (!button || !button.textContent || !button.textContent.includes('格式化文档')) return;
      // 只注入一次，后面的用例还要正常格式化
      window.removeEventListener('click', handler);
      const editor = document.querySelector('.cm-content');
      if (!(editor instanceof HTMLElement)) return;
      editor.focus();
      const data = new DataTransfer();
      data.setData('text/plain', '\n/*RACE_MARKER*/');
      editor.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    };
    window.addEventListener('click', handler);
  });
  await page.locator('.cm-content').first().click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  await page.getByRole('menuitem', { name: '格式化文档', exact: true }).click();
  await page.waitForTimeout(4000);
  const raceAfter = await editorText(page);
  assert(raceAfter.includes('/*RACE_MARKER*/'), '格式化期间输入的内容仍在文档里');
  assert(
    raceAfter.includes('const v0={a:0,b:1};'),
    '检测到并发修改后放弃格式化，没有用旧快照覆盖文档',
  );

  console.log('3. 格式化文档');
  await openFile(page, 'sample.js');
  const before = await editorText(page);
  assert(before.includes('const a={x:1,y:2}'), '打开的是未格式化的原文');
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

  console.log('5. 选区格式化只改选中的部分');
  await openFile(page, 'selection.js');
  const selBefore = await editorText(page);
  assert(selBefore.startsWith('var untouchedA={a:1,b:2};'), '首行为未格式化原文');
  assert(selBefore.includes('var untouchedB={c:3,d:4};'), '尾行为未格式化原文');
  // 光标放到第 2 行行首，再向下扩两行，选中第 2、3 两整行
  await page.locator('.cm-line').nth(1).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await page.locator('.cm-line').nth(1).click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  const selectionItem = page.getByRole('menuitem', { name: '格式化选区', exact: true });
  assert(!(await selectionItem.isDisabled()), '有选区时「格式化选区」可用');
  await selectionItem.click();
  await page.waitForTimeout(1500);
  const selAfter = await editorText(page);
  assert(selAfter.includes('var target = { x: 1, y: 2 };'), '选中的语句被格式化');
  assert(selAfter.includes('function g() {'), '选中的函数展开成多行');
  assert(selAfter.startsWith('var untouchedA={a:1,b:2};'), '选区外的前一行一字未变');
  assert(selAfter.trimEnd().endsWith('var untouchedB={c:3,d:4};'), '选区外的后一行一字未变');

  console.log('6. 无选区时「格式化选区」置灰');
  await page.locator('.cm-line').first().click();
  await page.locator('.cm-line').first().click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  assert(
    await page.getByRole('menuitem', { name: '格式化选区', exact: true }).isDisabled(),
    '无选区时「格式化选区」置灰',
  );
  await page.keyboard.press('Escape');

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
