// 源代码管理点开文件：未保存拦截、差异页签复用。需要独占 17382 端口。
// 跑之前先执行：
//   powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

// 端口被占时主进程直接退出，表现成 firstWindow 超时；提前报错更清楚
if (await isPortInUse(17382)) {
  console.error(
    '错误：端口 17382 已被占用，请先关闭正在运行的 Cmd Toolbox（或残留 electron 进程）再跑测试。',
  );
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-scm-data-'));
const repo = mkdtempSync(join(tmpdir(), 'cmdtb-scm-repo-'));

execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });

for (const name of ['a.txt', 'b.txt', 'c.txt']) {
  writeFileSync(join(repo, name), 'one\ntwo\n');
}
execFileSync('git', ['add', '.'], { cwd: repo });
execFileSync('git', ['commit', '-m', '初始提交'], { cwd: repo });

// 三个文件都产生工作区改动，才会出现在源代码管理列表里
for (const name of ['a.txt', 'b.txt', 'c.txt']) {
  writeFileSync(join(repo, name), 'one\nTWO\n');
}

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log('  ok  ' + message);
}

// 轮询到条件成立或超时。predicate 可以是异步的（要读 Playwright 的 DOM）。
async function waitFor(predicate, label, timeout = 15000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeout) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`等待超时：${label}${lastError ? `（${lastError.message}）` : ''}`);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.CMDTOOLBOX_NO_UPDATE = '1';

let app;
try {
  app = await electron.launch({
    executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
    cwd: root,
    args: ['.', `--data-dir=${dataDir}`],
    env,
  });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => console.log('  [pageerror]', error.message));
  await page.waitForLoadState('domcontentloaded');

  // 窗口被其他程序遮挡时 Chromium 不会投递合成的鼠标事件；确保置前
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.show();
    win?.focus();
    win?.moveTop();
  });

  await page.locator('.app').waitFor();
  await page.waitForFunction(() => !document.querySelector('.boot-screen'));
  await page.locator('.add-project-btn').waitFor({ timeout: 15000 });

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
  }

  async function selectProject(name) {
    await click(page.locator('.group-item').filter({ hasText: name }).locator('.group-main'));
    await waitFor(
      async () => (await page.locator('.git-panel').count()) > 0,
      `切换到 ${name} 后 Git 面板出现`,
    );
  }

  // 每个差异页签渲染一个 .diff-pane；页签被复用时数量不变
  async function countDiffPanes() {
    return page.locator('.diff-pane').count();
  }

  async function clickChange(name) {
    await click(page.locator('.git-change-row').filter({ hasText: name }).first());
  }

  async function visibleDiffPathIncludes(name) {
    const texts = await page.locator('.diff-pane:not(.is-hidden) .pane-path').allInnerTexts();
    return texts.some((text) => text.includes(name));
  }

  await addProject(repo, 'scm-proj');
  await selectProject('scm-proj');
  await waitFor(
    async () => (await page.locator('.git-change-row').count()) === 3,
    '源代码管理列出三个变更文件',
  );

  console.log('1. 未保存文件点击改为切到编辑器');
  {
    // 用源代码管理行内的「打开文件编辑」把 a.txt 放进编辑器。
    // 这条入口会把页签路径同步给 App，未保存拦截依赖它判断是同一个文件。
    await click(
      page
        .locator('.git-change-item')
        .filter({ hasText: 'a.txt' })
        .locator('.git-row-action[title="打开文件编辑"]'),
    );
    await waitFor(
      async () =>
        (await page
          .locator('.editor-pane:not(.is-hidden) .pane-path')
          .first()
          .innerText()).endsWith('a.txt'),
      '编辑器打开 a.txt',
    );
    await page
      .locator('.editor-pane:not(.is-hidden) .cm-content')
      .first()
      .waitFor({ timeout: 15000 });
    await click(page.locator('.editor-pane:not(.is-hidden) .cm-content').first());
    await page.keyboard.type('X');
    await page.locator('.editor-tab.active .editor-tab-dot').waitFor({ timeout: 8000 });
    assert(
      (await page.locator('.editor-pane:not(.is-hidden)').count()) === 1,
      '编辑器页签处于激活',
    );

    await clickChange('a.txt');
    await waitFor(
      async () => (await page.locator('.toast', { hasText: '未保存修改' }).count()) >= 1,
      '出现未保存修改提示',
    );
    assert((await countDiffPanes()) === 0, '没有新开差异页签');
    assert(
      (await page.locator('.editor-pane:not(.is-hidden)').count()) === 1,
      '激活的仍是编辑器页签',
    );
    assert(
      (await page.locator('.toast', { hasText: '未保存修改' }).count()) >= 1,
      '出现未保存提示',
    );
  }

  console.log('2. 保存后点击开差异页签');
  {
    // Ctrl+S 的处理器只在焦点位于编辑器内时生效，先点回编辑器内容区
    await click(page.locator('.editor-pane:not(.is-hidden) .cm-content').first());
    await page.keyboard.press('Control+s');
    await waitFor(
      async () => (await page.locator('.editor-tab.active .editor-tab-dot').count()) === 0,
      '保存后未保存圆点消失',
    );

    await clickChange('a.txt');
    await waitFor(async () => (await countDiffPanes()) === 1, '开出一个差异页签');
    await waitFor(() => visibleDiffPathIncludes('a.txt'), '差异页签显示 a.txt');
    assert((await countDiffPanes()) === 1, '开出一个差异页签');
  }

  console.log('3. 连续点不同文件只复用一个差异页签');
  {
    await clickChange('b.txt');
    await waitFor(() => visibleDiffPathIncludes('b.txt'), '差异页签内容切到 b.txt');
    assert((await countDiffPanes()) === 1, '点 b.txt 后仍然只有一个差异页签');

    await clickChange('c.txt');
    await waitFor(() => visibleDiffPathIncludes('c.txt'), '差异页签内容切到 c.txt');
    assert((await countDiffPanes()) === 1, '仍只有一个差异页签');
    assert(await visibleDiffPathIncludes('c.txt'), '内容是最后点击的 c.txt');
  }

  console.log('4. 交互过的差异页签不再被复用');
  {
    const body = page.locator('.diff-pane:not(.is-hidden) .diff-body');
    await body.hover();
    await page.mouse.wheel(0, 40);
    // 交互标记只写 ref、不动 DOM，没有可等待的条件；等事件派发完成即可
    await page.waitForTimeout(150);

    await clickChange('a.txt');
    await waitFor(async () => (await countDiffPanes()) === 2, '交互过之后新开一个差异页签');
    assert((await countDiffPanes()) === 2, '新开了一个差异页签');
  }

  console.log('5. 关闭后恢复复用');
  {
    // 隐藏页签是 display:none，鼠标点不到；直接触发元素自身的 click，
    // React 的委托监听照样能收到
    while ((await countDiffPanes()) > 0) {
      const before = await countDiffPanes();
      await page
        .locator('.diff-pane .icon-btn[title="关闭"]')
        .first()
        .evaluate((element) => element.click());
      await waitFor(async () => (await countDiffPanes()) < before, '关闭一个差异页签');
    }
    assert((await countDiffPanes()) === 0, '差异页签已全部关闭');

    await clickChange('b.txt');
    await waitFor(() => visibleDiffPathIncludes('b.txt'), '重新打开 b.txt 的差异');
    await clickChange('c.txt');
    await waitFor(() => visibleDiffPathIncludes('c.txt'), '复用后显示 c.txt');
    assert((await countDiffPanes()) === 1, '关闭后重新恢复到单页签复用');
  }
} finally {
  await app?.close().catch(() => {});
  for (const dir of [dataDir, repo]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.log(`  [cleanup] 临时目录清理失败：${error.message}`);
    }
  }
  // 残留 electron 会占着 17382 让下一次运行起不来
  const released = await waitForPortRelease(17382, 5000);
  if (released) {
    console.log('17382 端口已释放，无残留 electron 进程');
  } else {
    console.error('错误：17382 端口仍被占用，可能有残留 electron 进程');
    process.exitCode = 1;
  }
}

console.log(`\n全部通过：${passed} 项`);

function isPortInUse(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (inUse) => {
      socket.destroy();
      done(inUse);
    };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000);
  });
}

async function waitForPortRelease(port, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (!(await isPortInUse(port))) return true;
    await new Promise((done) => setTimeout(done, 200));
  }
  return false;
}
