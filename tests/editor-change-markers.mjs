// 编辑器 Git 变更标记。需要独占 17382 端口。
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-marker-data-'));
const repo = mkdtempSync(join(tmpdir(), 'cmdtb-marker-repo-'));
// 普通目录（不是 Git 仓库）：用来验证不会把整篇文件误判成新增
const plain = mkdtempSync(join(tmpdir(), 'cmdtb-marker-plain-'));
writeFileSync(join(plain, 'plain.txt'), 'one\ntwo\nthree\n');

execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });

// 提交版本：sample.txt 有改动，clean.txt 提交后保持原样。
// clean.txt 必须多于 1 行且内容与 sample.txt 不同：旧标记落在第 2、4 行，
// 只有一行时即使清空逻辑失效，标记也挂不上，断言等于没测。
writeFileSync(join(repo, 'sample.txt'), 'a\nb\nc\nd\n');
writeFileSync(join(repo, 'clean.txt'), 'alpha\nbeta\ngamma\n');
execFileSync('git', ['add', '.'], { cwd: repo });
execFileSync('git', ['commit', '-m', '初始提交'], { cwd: repo });

// 工作区版本：第 2 行改掉（modified，同时有删除锚点），第 4-6 行插入三行（连续 added 块）。
// 不要写成 a/B/X/d——那样 Myers 会算成「2、3 行都修改」，没有 added 色条可断言。
// 连续三行新增是 Alt+F5「一次跳过整块」的测试前提。
writeFileSync(join(repo, 'sample.txt'), 'a\nB\nc\nX\nY\nZ\nd\n');
// 未跟踪文件对 HEAD 对比时整篇算新增
writeFileSync(join(repo, 'new.txt'), 'brand new\n');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log('  ok  ' + message);
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
const page = await app.firstWindow();
page.on('pageerror', (error) => console.log('  [pageerror]', error.message));
await page.waitForLoadState('domcontentloaded');
await page.locator('.app').waitFor();
await page.waitForFunction(() => !document.querySelector('.boot-screen'));
await page.waitForTimeout(1200);

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

// 主进程不认 --project 参数，项目必须走界面添加
async function addProject(path, name) {
  const modal = page.locator('.modal-card');
  const deadline = Date.now() + 20000;
  while ((await modal.count()) === 0) {
    if (Date.now() > deadline) throw new Error('等待超时：添加项目弹窗未出现');
    await click(page.locator('.add-project-btn'));
    await page.waitForTimeout(600);
  }
  await page.locator('#project-path').fill(path);
  await page.locator('#project-name').fill(name);
  await click(page.getByRole('button', { name: '保存项目', exact: true }));
  await modal.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(600);
}

await addProject(repo, 'marker-proj');

// 添加项目后应用默认停在终端/Git 面板，编辑器页签必须手动打开
await page.locator('.group-item').filter({ hasText: 'marker-proj' }).locator('.group-main').click();
await page.waitForTimeout(600);
await page.locator('.group-item').filter({ hasText: 'marker-proj' }).click({ button: 'right' });
await page.locator('.popup-menu').waitFor({ timeout: 8000 });
await page.getByRole('menuitem', { name: '打开编辑器', exact: true }).click();
await page.locator('.editor-pane').waitFor();

async function openFile(name) {
  await click(page.locator(`.file-tree .file-row[title="${name}"]`));
  // 其他项目的编辑器页签仍挂在 DOM 里（is-hidden），等当前可见的那个，
  // 否则 first() 可能命中隐藏页签、文件还没加载完就往下走。
  await page.locator('.editor-pane:not(.is-hidden) .cm-editor').first().waitFor();
  await page.waitForTimeout(1200);
}

// 参考 tests/settings.mjs：编辑器显示设置要先在面板里改、点保存才生效。
async function setShowLineNumbers(enabled) {
  await click(page.locator('.titlebar-settings'));
  await page.locator('.settings-body').waitFor({ timeout: 15000 });
  await click(page.getByRole('tab', { name: '编辑器' }));
  await page.waitForTimeout(300);
  const toggle = page
    .locator('.settings-item')
    .filter({ hasText: '显示行号' })
    .locator('.settings-switch');
  const checked = (await toggle.getAttribute('aria-checked')) === 'true';
  if (checked !== enabled) await click(toggle);
  await click(page.getByRole('button', { name: '保存', exact: true }));
  await page.waitForTimeout(1200);
}

console.log('1. 修改与新增行显示色条');
await openFile('sample.txt');
assert(
  (await page.locator('.cm-change-marker.is-modified').count()) >= 1,
  '出现 modified 色条',
);
assert((await page.locator('.cm-change-marker.is-added').count()) >= 1, '出现 added 色条');
assert((await page.locator('.cm-change-triangle').count()) >= 1, '出现删除三角');

console.log('2. 概览标尺');
assert((await page.locator('.editor-overview-ruler .editor-overview-mark').count()) >= 2, '标尺有标记');

console.log('2b. 点击行号看 blame');
{
  await openFile('sample.txt');
  await page.locator('.cm-lineNumbers .cm-gutterElement').nth(1).click();
  await page.locator('.cm-blame-inline').first().waitFor({ timeout: 8000 });
  assert(await page.locator('.cm-blame-inline').count() > 0, '出现内联 blame 小字');
  await page.locator('.cm-blame-inline').first().hover();
  await page.locator('.blame-card').waitFor({ timeout: 8000 });
  assert(await page.locator('.blame-card').count() > 0, '悬停弹出 blame 卡片');
  assert(
    await page.locator('.blame-card .blame-diff-row').count() > 0,
    '卡片里有 diff 片段',
  );
}

console.log('2b1. 点正文任意位置也能看 blame');
{
  await openFile('sample.txt');
  const lineEls = page.locator('.editor-pane:not(.is-hidden) .cm-content .cm-line');
  const box = await lineEls.nth(2).boundingBox();
  await page.mouse.click(box.x + 20, box.y + box.height / 2);
  await page.locator('.cm-blame-inline').first().waitFor({ timeout: 8000 });
  assert(await page.locator('.cm-blame-inline').count() > 0, '点正文出现 blame 小字');
  // 点正文不能抢掉光标定位
  const cursorLine = await page.evaluate(() => {
    const sel = window.getSelection();
    const node = sel?.focusNode;
    const el = node?.nodeType === 3 ? node.parentElement : node;
    const lineEl = el instanceof Element ? el.closest('.cm-line') : null;
    const all = [...document.querySelectorAll('.cm-content .cm-line')];
    return lineEl ? all.indexOf(lineEl) + 1 : null;
  });
  assert(cursorLine === 3, `光标落在被点的第 3 行，实际：${cursorLine}`);
  // 立刻再点同一行：loading 中也必须能收起，否则用户会以为点了没反应
  await page.mouse.click(box.x + 20, box.y + box.height / 2);
  await page.waitForTimeout(600);
  assert((await page.locator('.cm-blame-inline').count()) === 0, '再点同一行收起 blame');
}

console.log('2b2. 有未保存修改时点行号不查 blame');
{
  await openFile('sample.txt');
  // 在首行末尾打一个字制造未保存修改
  const firstLine = page.locator('.editor-pane:not(.is-hidden) .cm-content .cm-line').first();
  const box = await firstLine.boundingBox();
  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
  await page.keyboard.type('!');
  await page.waitForTimeout(600);
  await page.locator('.cm-lineNumbers .cm-gutterElement').nth(1).click();
  await page.locator('.cm-blame-inline').first().waitFor({ timeout: 8000 });
  const blocked = await page.locator('.cm-blame-inline').first().innerText();
  assert(blocked.includes('有未保存修改'), '未保存修改时提示保存后再看 blame，实际：' + blocked);
  // 撤销回干净状态，避免影响后面的用例
  await page.locator('.editor-pane:not(.is-hidden) .cm-content').click();
  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(400);
}

console.log('2c. 中键拖拽选择');
{
  await openFile('sample.txt');
  // 2b 的 blame 内联 widget 挂在首行行尾，中键按在 widget 上会被 ignoreEvent 丢掉，从后面几行起拖。
  const lines = page.locator('.editor-pane:not(.is-hidden) .cm-content .cm-line');
  // 先左键点一下正文清掉可能残留的旧选区，避免把旧内容误算成这次拖拽的结果。
  const clear = await lines.nth(1).boundingBox();
  await page.mouse.click(clear.x + 4, clear.y + clear.height / 2);
  const start = await lines.nth(2).boundingBox();
  const end = await lines.nth(4).boundingBox();
  await page.mouse.move(start.x + 4, start.y + start.height / 2);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(end.x + 4, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up({ button: 'middle' });
  // CodeMirror 把选区同步到 DOM 是异步的，松手后立刻读可能还是空的。
  const selected = await page
    .waitForFunction(() => {
      const text = window.getSelection()?.toString() || '';
      return text.length > 0 ? text : false;
    }, null, { timeout: 5000 })
    .then((handle) => handle.jsonValue())
    .catch(() => '');
  // 实测拖第 3→5 行得到的是 "c\nX\n"，.cm-selectionBackground 数量为 0：
  // CodeMirror 的选区由原生 Selection 承载，所以直接断言选中的行内容。
  assert(selected.includes('c\nX'), '中键拖拽选中了第 3、4 行的内容，实际：' + JSON.stringify(selected));
}

console.log('2d. Alt+F5 跳转下一个改动');
{
  // .cm-cursor 是绝对定位在 .cm-cursorLayer 里的，不属于任何 .cm-line，
  // 所以取行号要走原生选区：focusNode 落在光标所在行的文本节点上。
  const cursorLine = () =>
    page.evaluate(() => {
      const visible = document.querySelector('.editor-pane:not(.is-hidden)');
      const lines = [...(visible?.querySelectorAll('.cm-content .cm-line') ?? [])];
      const node = window.getSelection()?.focusNode ?? null;
      const element = node instanceof Element ? node : (node?.parentElement ?? null);
      const line = element?.closest('.cm-line') ?? null;
      return line ? lines.indexOf(line) + 1 : 0;
    });

  await openFile('sample.txt');
  await page.locator('.editor-pane:not(.is-hidden) .cm-content').click();
  await page.keyboard.press('Control+Home');
  assert((await cursorLine()) === 1, '初始光标在第 1 行');
  await page.keyboard.press('Alt+F5');
  assert((await cursorLine()) === 2, 'Alt+F5 跳到第 2 行（modified 块起点）');
  await page.keyboard.press('Alt+F5');
  assert((await cursorLine()) === 4, '再按一次跳到第 4 行（added 块起点）');
  await page.keyboard.press('Alt+F5');
  // 第 4-6 行是连续新增块。逐行跳会停在 5，这里必须整块跳过并回绕到第 2 行。
  assert((await cursorLine()) === 2, '一次跳过整个三行新增块，回绕到第 2 行');
}

console.log('3. 干净文件没有标记');
// 先确认切换前标记确实存在，再切到干净文件确认归零：只断言「归零」无法区分
// 「清空逻辑生效」与「标记本来就没渲染出来」。
assert(
  (await page.locator('.cm-change-marker').count()) >= 1,
  '切换前文件仍有色条',
);
await openFile('clean.txt');
await page.waitForTimeout(600);
assert((await page.locator('.cm-change-marker').count()) === 0, '干净文件没有色条');
assert((await page.locator('.editor-overview-ruler').count()) === 0, '干净文件不画标尺');

console.log('3b. 未跟踪文件整篇算新增');
await openFile('new.txt');
await page.waitForTimeout(600);
assert((await page.locator('.cm-change-marker.is-added').count()) >= 1, '未跟踪文件显示 added 色条');

console.log('3c. 关掉「显示行号」后变更色条仍在');
{
  await openFile('sample.txt');
  await setShowLineNumbers(false);
  const visible = page.locator('.editor-pane:not(.is-hidden)');
  assert(
    (await visible.locator('.cm-lineNumbers').count()) === 0,
    '显示行号已关闭（行号 gutter 不存在）',
  );
  assert(
    (await visible.locator('.cm-change-marker.is-added').count()) >= 1,
    '关闭行号后 added 色条仍在',
  );
  await setShowLineNumbers(true);
  assert(
    (await page.locator('.editor-pane:not(.is-hidden) .cm-lineNumbers').count()) > 0,
    '行号设置已恢复',
  );
}

console.log('4. 非 Git 的普通目录不出标记');
await addProject(plain, 'plain-proj');
await page.locator('.group-item').filter({ hasText: 'plain-proj' }).locator('.group-main').click();
await page.waitForTimeout(600);
await page.locator('.group-item').filter({ hasText: 'plain-proj' }).click({ button: 'right' });
await page.locator('.popup-menu').waitFor({ timeout: 8000 });
await page.getByRole('menuitem', { name: '打开编辑器', exact: true }).click();
await page.locator('.editor-pane:not(.is-hidden)').waitFor();
await openFile('plain.txt');
await page.waitForTimeout(600);
// 仓库项目的编辑器页签仍在 DOM 里（隐藏），标记会残留。断言必须限定在
// 当前可见的编辑器里，否则测的是另一个项目残留的色条。
const visibleEditor = page.locator('.editor-pane:not(.is-hidden)');
assert(
  (await visibleEditor.locator('.cm-change-marker').count()) === 0,
  '非 Git 目录不出色条',
);
assert(
  (await visibleEditor.locator('.editor-overview-ruler').count()) === 0,
  '非 Git 目录不画标尺',
);

await app.close();
console.log(`\n全部通过：${passed} 项`);
