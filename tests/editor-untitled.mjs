// 空白窗口：新建、编号复用、另存为、撤销、覆盖拒绝、对比置灰、关闭确认、重启恢复。
// 需要独占 17382 端口，跑之前先关掉正在运行的 Cmd Toolbox。
import { _electron as electron } from 'playwright-core';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

// 端口被占时主进程会直接退出、窗口永远不出现，表现为 firstWindow 超时。
if (await isPortInUse(17382)) {
  console.error(
    '错误：端口 17382 已被占用，请先关闭正在运行的 Cmd Toolbox（或残留 electron 进程）再跑测试。',
  );
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-untitled-'));
const projectDir = mkdtempSync(join(tmpdir(), 'cmdtb-untitled-proj-'));
mkdirSync(join(projectDir, 'app'), { recursive: true });
console.log(`临时数据目录：${dataDir}`);
console.log(`临时项目目录：${projectDir}`);

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error('断言失败：' + message);
  passed += 1;
  console.log('  ok  ' + message);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.CMDTOOLBOX_NO_UPDATE = '1';

async function launch() {
  const app = await electron.launch({
    executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
    cwd: root,
    args: ['.', `--data-dir=${dataDir}`],
    env,
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
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
  return { app, page };
}

let session;
try {
  session = await launch();
  let page = session.page;

  // 加项目并打开编辑器
  await page.locator('.add-project-btn').click();
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill(projectDir);
  await page.locator('#project-name').fill('untitled');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await page.waitForTimeout(400);
  await page.locator('.group-item').filter({ hasText: 'untitled' }).locator('.group-main').click();
  await page.waitForTimeout(600);
  await page.locator('.group-item').filter({ hasText: 'untitled' }).click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  await page.getByRole('menuitem', { name: '打开编辑器', exact: true }).click();
  await page.locator('.editor-pane').waitFor();

  console.log('1. 点 ＋ 新建空白窗口，标题依次是 Untitled-1 / Untitled-2');
  await page.locator('.editor-tab-add').click();
  await page.waitForTimeout(600);
  const firstNames = await page.locator('.editor-tab-name').allInnerTexts();
  assert(firstNames.length === 1, `出现一个页签，实际 ${firstNames.length}`);
  assert(firstNames[0].includes('Untitled-1'), `标题是 Untitled-1，实际 ${firstNames[0]}`);
  await page.locator('.editor-tab-add').click();
  await page.waitForTimeout(600);
  const twoNames = await page.locator('.editor-tab-name').allInnerTexts();
  assert(twoNames.length === 2, `出现两个页签，实际 ${twoNames.length}`);
  assert(twoNames.some((name) => name.includes('Untitled-2')), '第二个是 Untitled-2');

  console.log('2. 关掉 Untitled-1 再新建，编号复用最小可用值');
  await page
    .locator('.editor-tab')
    .filter({ hasText: 'Untitled-1' })
    .locator('.editor-tab-close')
    .click();
  await page.waitForTimeout(500);
  await page.locator('.editor-tab-add').click();
  await page.waitForTimeout(600);
  const reusedNames = await page.locator('.editor-tab-name').allInnerTexts();
  assert(
    reusedNames.filter((name) => name.includes('Untitled-1')).length === 1,
    `新的 Untitled-1 只有一个，实际 ${reusedNames.join(',')}`,
  );
  assert(
    reusedNames.filter((name) => name.includes('Untitled-2')).length === 1,
    'Untitled-2 仍在',
  );
  // 只留一个空白窗口，后面「保存后虚拟页签消失」才有意义
  await page
    .locator('.editor-tab')
    .filter({ hasText: 'Untitled-2' })
    .locator('.editor-tab-close')
    .click();
  await page.waitForTimeout(400);
  assert(
    (await page.locator('.editor-tab-name').count()) === 1,
    '关掉 Untitled-2 后只剩一个空白窗口',
  );

  console.log('3. 输入内容 → Ctrl+S → 另存为 app/saved.php');
  await page.locator('.cm-content').first().click();
  await page.keyboard.type('<?php echo 1;');
  await page.keyboard.press('Control+s');
  const saveAsModal = page.locator('.modal-card').filter({ hasText: '另存为' });
  await saveAsModal.waitFor({ timeout: 8000 });
  assert(
    (await saveAsModal.locator('.modal-title').innerText()) === '另存为',
    '弹出标题为「另存为」的弹窗',
  );
  await saveAsModal.locator('input.text-input').first().fill('app/saved.php');
  await saveAsModal.getByRole('button', { name: '保存', exact: true }).click();
  await saveAsModal.waitFor({ state: 'detached', timeout: 10000 });
  await waitFor(
    () => existsSync(join(projectDir, 'app', 'saved.php')),
    8000,
    'saved.php 落盘',
  );
  assert(existsSync(join(projectDir, 'app', 'saved.php')), '文件落在磁盘上');
  assert(
    readFileSync(join(projectDir, 'app', 'saved.php'), 'utf8').includes('<?php echo 1;'),
    '内容写对了',
  );
  await waitFor(
    async () =>
      (await page.locator('.editor-tab-name').allInnerTexts()).some((name) =>
        name.includes('saved.php'),
      ),
    8000,
    '页签标题变成 saved.php',
  );
  const afterSave = await page.locator('.editor-tab-name').allInnerTexts();
  assert(afterSave.some((name) => name.includes('saved.php')), '页签标题变成文件名');
  assert(!afterSave.some((name) => name.includes('Untitled')), '虚拟页签已消失');
  // 另存为会新建文件（还可能自动创建父目录），文件树必须跟着刷新，
  // 不能等用户手动点刷新才看得到。
  await waitFor(
    async () =>
      (await page.locator('.file-tree .file-row').filter({ hasText: 'saved.php' }).count()) > 0,
    8000,
    '文件树出现 saved.php',
  );
  assert(
    (await page.locator('.file-tree .file-row').filter({ hasText: 'saved.php' }).count()) > 0,
    '文件树里能看到 saved.php 这一行',
  );

  console.log('4. 保存后 Ctrl+Z 能撤销保存前的输入');
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  const undoneText = (await page.locator('.cm-content').first().innerText()).trim();
  // 保存前这个窗口是空的；撤销必须回到空串。只断言「不含 echo 1」在视图被
  // 整个清空时也会通过，测不出撤销是否真的生效。
  assert(
    undoneText === '',
    `撤销后回到保存前的空白内容，实际 ${JSON.stringify(undoneText)}`,
  );

  console.log('5. 另存为到已存在的路径：弹窗报错且不覆盖原文件');
  await page.locator('.editor-tab-add').click();
  await page.waitForTimeout(600);
  await page.locator('.cm-content').first().click();
  await page.keyboard.type('OVERWRITE');
  await page.keyboard.press('Control+s');
  const conflictModal = page.locator('.modal-card').filter({ hasText: '另存为' });
  await conflictModal.waitFor({ timeout: 8000 });
  await conflictModal.locator('input.text-input').first().fill('app/saved.php');
  await conflictModal.getByRole('button', { name: '保存', exact: true }).click();
  await conflictModal.locator('[role="alert"]').waitFor({ timeout: 8000 });
  assert(
    (await page.locator('.modal-card').filter({ hasText: '另存为' }).count()) === 1,
    '弹窗保持打开',
  );
  assert(
    (await conflictModal.locator('[role="alert"]').innerText()).length > 0,
    '弹窗里显示错误提示',
  );
  assert(
    readFileSync(join(projectDir, 'app', 'saved.php'), 'utf8').includes('<?php echo 1;'),
    '原文件未被覆盖',
  );
  await conflictModal.getByRole('button', { name: '取消', exact: true }).click();
  await conflictModal.waitFor({ state: 'detached', timeout: 5000 });

  console.log('6. 空白窗口的「与已保存文件比较」「与 Git HEAD 比较」置灰');
  const untitledRow = page.locator('.open-editors-list .file-row[title^="untitled://"]').first();
  await untitledRow.waitFor({ timeout: 5000 });
  await untitledRow.click({ button: 'right' });
  await page.locator('.popup-menu').waitFor({ timeout: 8000 });
  assert(
    await page.getByRole('menuitem', { name: '与已保存文件比较', exact: true }).isDisabled(),
    '「与已保存文件比较」置灰',
  );
  assert(
    await page.getByRole('menuitem', { name: '与 Git HEAD 比较', exact: true }).isDisabled(),
    '「与 Git HEAD 比较」置灰',
  );
  assert(
    !(await page.getByRole('menuitem', { name: '选择以进行比较', exact: true }).isDisabled()),
    '「选择以进行比较」可点',
  );
  await page.keyboard.press('Escape');
  await page.locator('.popup-menu').waitFor({ state: 'detached', timeout: 5000 });

  console.log('7. 有内容的空白窗口关闭时弹确认');
  await page
    .locator('.editor-tab')
    .filter({ hasText: 'Untitled-1' })
    .locator('.editor-tab-close')
    .click();
  const closeConfirm = page.locator('.modal-card.editor-confirm');
  await closeConfirm.waitFor({ timeout: 5000 });
  const closeMessage = await closeConfirm.locator('.confirm-message').innerText();
  assert(closeMessage.includes('未保存'), `确认框点名未保存修改，实际「${closeMessage}」`);
  await closeConfirm.getByRole('button', { name: '取消', exact: true }).click();
  await closeConfirm.waitFor({ state: 'detached', timeout: 5000 });
  assert(
    (await page.locator('.editor-tab').filter({ hasText: 'Untitled-1' }).count()) === 1,
    '取消后空白窗口仍在',
  );

  console.log('8. 重启应用后空白窗口与内容恢复');
  await session.app.close();
  await waitForPortRelease(17382, 10000);
  await new Promise((done) => setTimeout(done, 800));
  session = await launch();
  page = session.page;
  await page.locator('.editor-pane').waitFor({ timeout: 15000 });
  await page.waitForTimeout(1000);
  const restoredNames = await page.locator('.editor-tab-name').allInnerTexts();
  assert(
    restoredNames.some((name) => name.includes('Untitled-1')),
    `重启后恢复 Untitled-1，实际 ${restoredNames.join(',')}`,
  );
  const restoredText = await page.locator('.cm-content').first().innerText();
  assert(restoredText.includes('OVERWRITE'), '重启后内容恢复');
} finally {
  await session?.app.close().catch(() => {});
  for (const dir of [dataDir, projectDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.log(`  [cleanup] 临时目录清理失败：${error.message}`);
    }
  }
  // 残留 electron 会占着 17382 让下一次运行起不来，跑完必须确认端口真的释放了
  const released = await waitForPortRelease(17382, 5000);
  if (released) {
    console.log('17382 端口已释放，无残留 electron 进程');
  } else {
    console.error('错误：17382 端口仍被占用，可能有残留 electron 进程');
    process.exitCode = 1;
  }
}

console.log(`\n全部通过：${passed} 项`);

// 轮询到条件成立或超时。predicate 可以是异步的（要读 Playwright 的 DOM）。
async function waitFor(predicate, timeout, label) {
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
