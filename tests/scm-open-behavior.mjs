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

// 三个文件都产生工作区改动，才会出现在源代码管理列表里。
// b.txt 的内容与另外两个不同，用来确认编辑器真正打开的是它。
writeFileSync(join(repo, 'a.txt'), 'one\nTWO\n');
writeFileSync(join(repo, 'b.txt'), 'alpha\nBEE\n');
writeFileSync(join(repo, 'c.txt'), 'one\nTWO\n');

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

  // 提示 2.4 秒后自动消失。等上一条提示退场，才能确定接下来看到的
  // 「未保存修改」提示是本次点击产生的，而不是上一段留下的。
  async function waitForNoToast() {
    await waitFor(async () => (await page.locator('.toast').count()) === 0, '上一条提示已消失', 6000);
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
    // 1a. 文件树是最常见的入口。这里必须走它：页签路径同步给 App 后，
    // 未保存拦截才认得出点的是同一个文件（修好后这里不再新开差异页签）。
    await page
      .locator('.group-item')
      .filter({ hasText: 'scm-proj' })
      .click({ button: 'right' });
    await page.locator('.popup-menu').waitFor({ timeout: 8000 });
    await page.getByRole('menuitem', { name: '打开编辑器', exact: true }).click();
    await page.locator('.editor-pane').waitFor({ timeout: 15000 });
    await page.locator('.file-tree .file-row[title="a.txt"]').waitFor({ timeout: 10000 });
    await click(page.locator('.file-tree .file-row[title="a.txt"]'));
    await waitFor(
      async () =>
        (await page
          .locator('.editor-pane:not(.is-hidden) .pane-path')
          .first()
          .innerText()).endsWith('a.txt'),
      '文件树打开 a.txt',
    );
    await page
      .locator('.editor-pane:not(.is-hidden) .cm-content')
      .first()
      .waitFor({ timeout: 15000 });
    await click(page.locator('.editor-pane:not(.is-hidden) .cm-content').first());
    await page.keyboard.type('X');
    await page.locator('.editor-tab.active .editor-tab-dot').waitFor({ timeout: 8000 });

    await waitForNoToast();
    await clickChange('a.txt');
    await waitFor(
      async () => (await page.locator('.toast', { hasText: '未保存修改' }).count()) >= 1,
      '出现未保存修改提示',
    );
    assert((await countDiffPanes()) === 0, '没有新开差异页签（文件树入口）');
    assert(
      (await page.locator('.editor-pane:not(.is-hidden)').count()) === 1,
      '激活的仍是编辑器页签（文件树入口）',
    );

    // 1b. 关掉编辑器，再从 Git 面板行内入口打开同一个文件。
    // 两个入口都依赖 tab.filePath 同步，行为应完全一致。
    // 关闭编辑器会连弹两次 window.confirm（编辑器内确认 + App 关页签确认），
    // 两个都要接受，否则 Playwright 默认按取消处理，页签关不掉。
    const acceptCloseDialog = (dialog) => dialog.accept();
    page.on('dialog', acceptCloseDialog);
    await click(
      page.locator('.editor-pane:not(.is-hidden) .pane-header .icon-btn[title="关闭"]'),
    );
    await waitFor(
      async () => (await page.locator('.editor-pane').count()) === 0,
      '编辑器页签已关闭（放弃未保存修改）',
    );
    page.off('dialog', acceptCloseDialog);

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
      'Git 面板打开 a.txt',
    );
    await page
      .locator('.editor-pane:not(.is-hidden) .cm-content')
      .first()
      .waitFor({ timeout: 15000 });
    await click(page.locator('.editor-pane:not(.is-hidden) .cm-content').first());
    await page.keyboard.type('X');
    await page.locator('.editor-tab.active .editor-tab-dot').waitFor({ timeout: 8000 });

    await waitForNoToast();
    await clickChange('a.txt');
    await waitFor(
      async () => (await page.locator('.toast', { hasText: '未保存修改' }).count()) >= 1,
      'Git 面板入口出现未保存修改提示',
    );
    assert((await countDiffPanes()) === 0, '没有新开差异页签（Git 面板入口）');
    assert(
      (await page.locator('.editor-pane:not(.is-hidden)').count()) === 1,
      '激活的仍是编辑器页签（Git 面板入口）',
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
  }

  console.log('3. 连续点不同文件只复用一个差异页签');
  {
    await clickChange('b.txt');
    await waitFor(() => visibleDiffPathIncludes('b.txt'), '差异页签内容切到 b.txt');
    assert((await countDiffPanes()) === 1, '点 b.txt 后仍然只有一个差异页签');

    await clickChange('c.txt');
    await waitFor(() => visibleDiffPathIncludes('c.txt'), '差异页签内容切到 c.txt');
    assert((await countDiffPanes()) === 1, '仍只有一个差异页签');
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

  console.log('6. 复用未触碰的编辑器页签换文件后，路径收敛到新文件');
  {
    // 先切回编辑器页签再关掉它，重建一个没被编辑过的编辑器，满足复用条件
    await click(page.locator('.tab').filter({ hasText: 'a.txt' }).first());
    await page.locator('.editor-pane:not(.is-hidden)').waitFor({ timeout: 8000 });
    await click(
      page.locator('.editor-pane:not(.is-hidden) .pane-header .icon-btn[title="关闭"]'),
    );
    await waitFor(
      async () => (await page.locator('.editor-pane').count()) === 0,
      '编辑器页签已关闭',
    );

    async function openFromGitPanel(name) {
      await click(
        page
          .locator('.git-change-item')
          .filter({ hasText: name })
          .locator('.git-row-action[title="打开文件编辑"]'),
      );
    }
    async function activeEditorPath() {
      return page
        .locator('.editor-pane:not(.is-hidden) .pane-path')
        .first()
        .innerText();
    }

    // 新编辑器打开 a.txt，但不输入任何内容：App 侧仍认为它未被触碰。
    await openFromGitPanel('a.txt');
    await waitFor(async () => (await activeEditorPath()).endsWith('a.txt'), 'Git 面板打开 a.txt');
    await page
      .locator('.editor-pane:not(.is-hidden) .cm-content')
      .first()
      .waitFor({ timeout: 15000 });
    const editorTabsBefore = await page.locator('.editor-tab').count();

    // App 复用同一个页签把 filePath 改成 b.txt；这一轮编辑器里还是 a.txt，
    // 旧实现会把 a.txt 写回 App，形成 b.txt → a.txt → b.txt 的往返。
    await openFromGitPanel('b.txt');
    await waitFor(async () => (await activeEditorPath()).endsWith('b.txt'), '编辑器切到 b.txt');
    // 留一轮渲染 + 状态回写的时间再复查。注意这里只能验证「终态收敛」：
    // 实测往返即使发生，300ms 后也已经收敛回 b.txt，从最终 DOM 观测不到
    // 中间态，因此这条断言无法区分「没有回写」和「回写后又改回来」。
    await page.waitForTimeout(300);
    assert((await page.locator('.editor-pane').count()) === 1, '编辑器页签数量不增加');
    assert(
      (await page.locator('.editor-tab').count()) === editorTabsBefore,
      '编辑器内页签数量不增加（复用而不是新建）',
    );
    assert(
      (await activeEditorPath()).endsWith('b.txt'),
      '终态路径收敛在 b.txt（只验证终态，不区分是否发生过往返）',
    );
    assert(
      (await page
        .locator('.editor-pane:not(.is-hidden) .cm-content')
        .first()
        .innerText()).includes('BEE'),
      '内容是 b.txt 的',
    );
  }

  console.log('7. 关闭最后一个文件后，从 Git 面板打开文件');
  {
    // 关掉编辑器里最后一个文件页签：编辑器面板还在，只是没有任何文件。
    await page.locator('.editor-tab.active .editor-tab-close').click();
    await waitFor(
      async () => (await page.locator('.editor-tab').count()) === 0,
      '编辑器内文件页签已清空',
    );
    assert((await page.locator('.editor-pane').count()) === 1, '编辑器页签仍开着（只是没有文件）');
    // 空路径回写要等下一次 App 渲染才落到页签上；立刻点会被按旧 filePath 去重，
    // 这里等它稳定，模拟用户关掉文件后稍作停顿再点。
    await page.waitForTimeout(300);

    // 关掉的是 b.txt，再从 Git 面板打开同一个文件。页签路径若残留在 b.txt，
    // openEditorFile 会按 filePath 去重，只激活这个空页签，不会真的打开文件。
    await click(
      page
        .locator('.git-change-item')
        .filter({ hasText: 'b.txt' })
        .locator('.git-row-action[title="打开文件编辑"]'),
    );
    await waitFor(
      async () =>
        (await page
          .locator('.editor-pane:not(.is-hidden) .pane-path')
          .first()
          .innerText()).endsWith('b.txt'),
      '关闭全部文件后重新打开 b.txt',
    );
    await page
      .locator('.editor-pane:not(.is-hidden) .cm-content')
      .first()
      .waitFor({ timeout: 15000 });
    assert(
      (await page
        .locator('.editor-pane:not(.is-hidden) .cm-content')
        .first()
        .innerText()).includes('BEE'),
      '真的打开了 b.txt（不是只激活空页签）',
    );
  }

  console.log('8. 未保存拦截按具体文件判断，而不是整个页签');
  {
    // 清掉前面留下的差异页签，便于直接断言「有没有新开」。
    while ((await countDiffPanes()) > 0) {
      const before = await countDiffPanes();
      await page
        .locator('.diff-pane .icon-btn[title="关闭"]')
        .first()
        .evaluate((element) => element.click());
      await waitFor(async () => (await countDiffPanes()) < before, '关闭差异页签');
    }

    // 先打开 a.txt：当前 b.txt 没被碰过，会被 a.txt 顶替。
    await click(page.locator('.file-tree .file-row[title="a.txt"]'));
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
    // 让 a.txt 变脏，下一个打开的文件就不会把它顶替掉。
    await click(page.locator('.editor-pane:not(.is-hidden) .cm-content').first());
    await page.keyboard.type('X');
    await page.locator('.editor-tab.active .editor-tab-dot').waitFor({ timeout: 8000 });

    // 再打开 b.txt：a.txt 已脏，只剩新增页签一条路，两个文件同时开着。
    await click(page.locator('.file-tree .file-row[title="b.txt"]'));
    await waitFor(
      async () =>
        (await page
          .locator('.editor-pane:not(.is-hidden) .pane-path')
          .first()
          .innerText()).endsWith('b.txt'),
      '编辑器切到 b.txt',
    );
    await waitFor(
      async () => (await page.locator('.editor-tab').count()) === 2,
      'a.txt 与 b.txt 同时打开',
    );

    // 点真正脏的 a.txt：即便编辑器当前停在 b.txt，也必须拦下差异页签。
    await waitForNoToast();
    await clickChange('a.txt');
    await waitFor(
      async () => (await page.locator('.toast', { hasText: '未保存修改' }).count()) >= 1,
      '点脏文件出现未保存修改提示',
    );
    assert((await countDiffPanes()) === 0, '点脏的 a.txt 没有开差异页签');
    assert(
      (await page.locator('.editor-pane:not(.is-hidden)').count()) === 1,
      '点脏的 a.txt 切回编辑器页签',
    );
    assert(
      (await page
        .locator('.editor-pane:not(.is-hidden) .pane-path')
        .first()
        .innerText()).endsWith('a.txt'),
      '编辑器显示被点的脏文件 a.txt',
    );

    // 点干净的 b.txt：不能被后台的脏文件误拦，必须正常开差异页签。
    await waitForNoToast();
    await clickChange('b.txt');
    await waitFor(async () => (await countDiffPanes()) === 1, '点干净的 b.txt 正常开差异页签');
    assert(await visibleDiffPathIncludes('b.txt'), '差异页签显示 b.txt');
  }

  console.log('9. 重命名差异页签后标题不被复用覆盖');
  {
    // 当前只有一个差异页签（b.txt）。右键改个名字。
    await page
      .locator('.tab')
      .filter({ hasText: 'b.txt' })
      .first()
      .click({ button: 'right' });
    await page.locator('.popup-menu').waitFor({ timeout: 8000 });
    await page.getByRole('menuitem', { name: '重命名用途', exact: true }).click();
    const renameModal = page.locator('.modal-card').filter({ hasText: '重命名终端用途' });
    await renameModal.waitFor({ timeout: 8000 });
    await page.locator('#tab-purpose').fill('我的差异');
    await click(page.getByRole('button', { name: '保存名称', exact: true }));
    await renameModal.waitFor({ state: 'detached', timeout: 8000 });
    await waitFor(
      async () => (await page.locator('.tab').filter({ hasText: '我的差异' }).count()) >= 1,
      '差异页签已改名',
    );

    // 再点另一个文件：改过名的页签算「碰过」，不能被复用、标题不能被覆盖。
    await clickChange('c.txt');
    await waitFor(async () => (await countDiffPanes()) === 2, '改名后另开差异页签，不覆盖标题');
    assert(
      (await page.locator('.tab').filter({ hasText: '我的差异' }).count()) >= 1,
      '改名后的页签标题仍在',
    );
    assert(await visibleDiffPathIncludes('c.txt'), '新差异页签显示 c.txt');
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
