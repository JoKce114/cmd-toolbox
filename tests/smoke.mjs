import { _electron as electron } from 'playwright-core';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = resolve(root, '.test-data');
const shots = resolve(root, 'test-shots');
rmSync(dataDir, { recursive: true, force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// 测试环境不发真实的 GitHub 更新请求
env.CMDTOOLBOX_NO_UPDATE = '1';

let app;
let passed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

async function launch() {
  app = await electron.launch({
    executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
    cwd: root,
    args: ['.', `--data-dir=${dataDir}`],
    env,
  });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => console.log('  [pageerror]', error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') console.log('  [console]', message.text());
  });
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.app').waitFor();
  await page.waitForTimeout(500);
  return page;
}

async function shot(page, name) {
  await page.screenshot({ path: resolve(shots, name) });
  console.log(`  shot ${name}`);
}

async function click(page, locator) {
  try {
    await locator.click({ timeout: 6000 });
  } catch (error) {
    const box = await locator.boundingBox();
    if (!box) throw error;
    console.log('  (actionability fallback -> mouse.click)');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
}

async function waitRows(page, needle, timeout = 8000) {
  await page.waitForFunction(
    (text) => {
      const pane = document.querySelector('.terminal-pane:not(.is-hidden)');
      const rows = pane?.querySelector('.xterm-rows');
      return Boolean(rows && rows.textContent.includes(text));
    },
    needle,
    { timeout },
  );
}

async function activeRows(page) {
  return page.locator('.terminal-pane:not(.is-hidden) .xterm-rows').innerText();
}

async function tabTitles(page) {
  return page.locator('.tab .tab-title').allInnerTexts();
}

async function addProject(page, { path, name }) {
  await click(page, page.locator('.add-project-btn'));
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill(path);
  if (name) await page.locator('#project-name').fill(name);
  await click(page, page.getByRole('button', { name: '保存项目', exact: true }));
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await page.waitForTimeout(350);
}

try {
  console.log('1. 启动与空状态');
  let page = await launch();
  assert((await page.locator('.boot-screen').count()) === 0, '应用进入主界面（无启动错误）');
  assert(await page.locator('.group-main').first().innerText().then((t) => t.includes('全局终端')), '存在内置全局终端');
  assert(await page.locator('.projects-empty').isVisible(), '空项目提示可见');
  await shot(page, '01-global-empty.png');

  console.log('2. 添加项目并打开终端');
  await addProject(page, { path: 'D:/project-demo/cmd-controllers' });
  const sidebarText = await page.locator('.sidebar').innerText();
  assert(sidebarText.includes('cmd-controllers'), '项目已出现在左侧菜单');
  assert(sidebarText.includes('D:\\project-demo\\cmd-controllers'), '项目路径已保存显示');
  assert((await page.locator('.group-item').count()) === 2, '全局 + 一个项目分组');
  await shot(page, '02-project-empty.png');

  await click(page, page.getByRole('button', { name: '打开命令提示符', exact: true }));
  await page.locator('.terminal-pane').waitFor();
  await waitRows(page, 'cmd-controllers>');
  assert(await page.locator('.tab').first().innerText().then((t) => t.includes('cmd-controllers')), '页签标题包含项目名');
  assert(await page.locator('.tab').first().innerText().then((t) => t.includes('命令提示符')), '页签标题包含终端用途');
  await click(page, page.locator('.terminal-pane:not(.is-hidden) .xterm-screen'));
  await page.keyboard.type('echo project-cmd-ok');
  await page.keyboard.press('Enter');
  await waitRows(page, 'project-cmd-ok');
  await shot(page, '03-terminal-running.png');

  console.log('3. 同一项目打开多个终端并重命名用途');
  await click(page, page.locator('.xterm-screen'));
  await page.keyboard.press('Control+T');
  await page.waitForTimeout(700);
  assert((await page.locator('.tab').count()) === 2, 'Ctrl+T 新建第二个终端页签');
  let titles = await tabTitles(page);
  // 两个页签靠 #序号 区分，名称本身不再追加「2」
  assert(new Set(titles.map((title) => title.split(' ')[0])).size === 2, '每个页签有独立的 #序号');

  await click(page, page.locator('.tab').first());
  await page.locator('.tab').first().dblclick();
  await page.locator('.modal-card').waitFor();
  await page.locator('#tab-purpose').fill('启动服务');
  await click(page, page.getByRole('button', { name: '保存名称', exact: true }));
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  titles = await tabTitles(page);
  assert(titles.some((title) => title.includes('cmd-controllers') && title.includes('启动服务')), '重命名后页签为「项目 · 用途」');
  await shot(page, '04-two-tabs-renamed.png');

  await click(page, page.locator('.tab').first());
  assert((await activeRows(page)).includes('project-cmd-ok'), '切回页签后保留终端现场');
  await page.locator('.tab').nth(1).click();
  await page.waitForTimeout(500);

  console.log('4. 编辑项目记录');
  const projectRow = page.locator('.group-item').filter({ hasText: 'cmd-controllers' }).locator('.group-main');
  await projectRow.click({ button: 'right' });
  await page.locator('.popup-menu').waitFor();
  assert(await page.locator('.popup-menu').innerText().then((t) => t.includes('编辑项目')), '项目右键菜单包含编辑');
  await click(page, page.getByRole('menuitem', { name: '编辑项目', exact: true }));
  await page.locator('#project-name').fill('Cmd Controllers');
  await click(page, page.getByRole('button', { name: '保存修改', exact: true }));
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  titles = await tabTitles(page);
  assert(titles.every((title) => title.includes('Cmd Controllers')), '项目改名后页签同步显示新项目名');
  assert((await page.locator('.sidebar').innerText()).includes('Cmd Controllers'), '项目改名已保存');

  console.log('5. 第二个项目 + PowerShell');
  await addProject(page, { path: 'D:/project-demo/cmd-toolbox', name: 'Toolbox Dev' });
  assert((await page.locator('.sidebar').innerText()).includes('Toolbox Dev'), '第二个项目已添加');
  assert((await page.locator('.terminal-pane').count()) === 2, '切换项目不会销毁第一个项目的终端');
  await click(page, page.locator('.empty-actions .btn-secondary'));
  await page.locator('.popup-menu').waitFor();
  await page.waitForTimeout(250);
  await shot(page, '05-shell-menu.png');
  await click(page, page.getByRole('menuitem', { name: 'PowerShell', exact: true }));
  await page.waitForTimeout(1400);
  assert((await page.locator('.tab').count()) === 1, '新项目独立维护自己的页签');
  assert(await page.locator('.tab').first().innerText().then((t) => t.includes('PowerShell')), '页签显示 PowerShell 类型');
  assert(
    (await page.locator('.terminal-pane:not(.is-hidden) .pane-shell').innerText()) === 'PS',
    '终端头部显示 PS 标识',
  );
  await click(page, page.locator('.terminal-pane:not(.is-hidden) .xterm-screen'));
  await page.keyboard.type('Write-Output ps-ok');
  await page.keyboard.press('Enter');
  await waitRows(page, 'ps-ok');
  await shot(page, '06-second-project-ps.png');

  console.log('6. 分组切换与全局终端');
  await page.locator('.group-item').filter({ hasText: 'Cmd Controllers' }).locator('.group-main').click();
  await page.waitForTimeout(500);
  assert((await page.locator('.tab').count()) === 2, '回到第一个项目，页签数量正确');
  await page.locator('.group-item').filter({ hasText: '全局终端' }).locator('.group-main').click();
  await click(page, page.locator('.empty-actions .btn-primary'));
  await page.waitForTimeout(1100);
  await waitRows(page, 'Users\\Administrator>');
  await click(page, page.locator('.terminal-pane:not(.is-hidden) .xterm-screen'));
  await page.keyboard.type('echo global-ok');
  await page.keyboard.press('Enter');
  await waitRows(page, 'global-ok');
  assert((await page.locator('.sidebar').innerText()).includes('全局终端'), '全局终端与项目终端并存');
  await shot(page, '07-global-terminal.png');

  await page.locator('.group-item').filter({ hasText: 'Cmd Controllers' }).locator('.group-main').click();
  await page.waitForTimeout(400);
  await page.locator('.group-item').filter({ hasText: 'Toolbox Dev' }).locator('.group-main').click();
  await page.waitForTimeout(400);
  await shot(page, '08-project-switch.png');

  console.log('7. 关闭页签快捷键');
  await page.locator('.terminal-pane:not(.is-hidden) .xterm-screen').click();
  await page.keyboard.press('Control+W');
  await page.waitForTimeout(400);
  assert((await page.locator('.tab').count()) === 0, 'Ctrl+W 关闭当前项目最后一个页签');
  await page.locator('.group-item').filter({ hasText: 'Cmd Controllers' }).locator('.group-main').click();
  await page.waitForTimeout(300);
  assert((await page.locator('.tab').count()) === 2, '其他项目页签不受影响');

  console.log('8. 进程退出与重启');
  await page.locator('.tab').nth(1).click();
  await click(page, page.locator('.terminal-pane:not(.is-hidden) .xterm-screen'));
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  await page.locator('.exit-overlay').waitFor({ timeout: 8000 });
  assert((await page.locator('.exit-overlay').innerText()).includes('进程已结束'), '进程退出后显示重启浮层');
  await shot(page, '09-exit-overlay.png');
  await click(page, page.getByRole('button', { name: '重新启动', exact: true }));
  await page.locator('.exit-overlay').waitFor({ state: 'detached', timeout: 8000 });
  await page.waitForTimeout(1200);
  await click(page, page.locator('.terminal-pane:not(.is-hidden) .xterm-screen'));
  await page.keyboard.type('echo restarted-ok');
  await page.keyboard.press('Enter');
  await waitRows(page, 'restarted-ok');
  assert(true, '重启后终端恢复可用');

  console.log('9. 复制工作目录与触屏菜单');
  await click(page, page.locator('.terminal-pane:not(.is-hidden) .pane-path'));
  await page.waitForTimeout(200);
  const clipboardText = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert(clipboardText === 'D:\\project-demo\\cmd-controllers', '点击路径可复制工作目录');
  await click(page, page.locator('.tab').first());
  await page.locator('.tab').first().click({ button: 'right' });
  await page.locator('.popup-menu').waitFor();
  assert(await page.locator('.popup-menu').innerText().then((t) => t.includes('关闭其他')), '页签右键菜单可用');
  await page.waitForTimeout(200);
  await shot(page, '10-tab-menu.png');
  await page.keyboard.press('Escape');

  console.log('10. 剪贴板粘贴与窗口缩放');
  await app.evaluate(({ clipboard }) => clipboard.writeText('echo pasted-ok'));
  await click(page, page.locator('.terminal-pane:not(.is-hidden) .xterm-screen'));
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(350);
  await page.keyboard.press('Enter');
  await waitRows(page, 'pasted-ok');
  assert(true, '终端 Ctrl+V 粘贴并执行成功');

  await page.locator('.tab').nth(1).dblclick();
  await page.locator('.modal-card').waitFor();
  await app.evaluate(({ clipboard }) => clipboard.writeText('粘贴用途'));
  await page.locator('#tab-purpose').fill('');
  await page.locator('#tab-purpose').press('Control+V');
  await page.waitForTimeout(200);
  assert((await page.locator('#tab-purpose').inputValue()) === '粘贴用途', '输入框内 Ctrl+V 使用系统剪贴板');
  await page.keyboard.press('Escape');
  await page.locator('.modal-card').waitFor({ state: 'detached' });

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1100, 720);
  });
  await page.waitForTimeout(600);
  const terminalFits = await page.evaluate(() => {
    const mount = document.querySelector('.terminal-pane:not(.is-hidden) .terminal-mount');
    const screen = mount?.querySelector('.xterm-screen');
    if (!mount || !screen) return false;
    return screen.getBoundingClientRect().width <= mount.getBoundingClientRect().width + 2;
  });
  assert(terminalFits, '缩小窗口后终端自适应宽度');
  assert((await page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width)) === 248, '窄窗口下侧栏切换为紧凑宽度');
  await shot(page, '13-small-window.png');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1380, 880);
  });
  await page.waitForTimeout(500);

  console.log('11. 删除项目');
  const toolboxRow = page.locator('.group-item').filter({ hasText: 'Toolbox Dev' }).locator('.group-main');
  await toolboxRow.click({ button: 'right' });
  await click(page, page.getByRole('menuitem', { name: '删除项目', exact: true }));
  await page.locator('.modal-card').waitFor();
  await page.waitForTimeout(250);
  assert((await page.locator('.modal-card').innerText()).includes('不会删除磁盘上的任何文件'), '删除确认说明不会删除磁盘文件');
  await shot(page, '11-delete-confirm.png');
  await click(page, page.getByRole('button', { name: '删除项目', exact: true }));
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await page.waitForTimeout(400);
  assert(!(await page.locator('.sidebar').innerText()).includes('Toolbox Dev'), '项目记录已删除');

  console.log('12. 重启应用验证持久化');
  await app.close();
  app = null;
  page = await launch();
  const persisted = await page.locator('.sidebar').innerText();
  assert(persisted.includes('Cmd Controllers'), '重启后项目记录仍在');
  assert(!persisted.includes('Toolbox Dev'), '删除的项目不会恢复');
  assert(await page.locator('.group-item').count() === 2, '重启后只保留一个项目 + 全局');
  await page.locator('.group-item').filter({ hasText: 'Cmd Controllers' }).locator('.group-main').click();
  await page.waitForTimeout(300);
  await shot(page, '12-restart-persisted.png');

  console.log(`\n全部通过：${passed} 项断言`);
} finally {
  if (app) await app.close().catch(() => {});
}
