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

// 工作区版本：第 2 行改掉（modified，同时有删除锚点），第 4 行插入一行（added）。
// 不要写成 a/B/X/d——那样 Myers 会算成「2、3 行都修改」，没有 added 色条可断言。
writeFileSync(join(repo, 'sample.txt'), 'a\nB\nc\nX\nd\n');
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
