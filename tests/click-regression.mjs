import { _electron as electron } from 'playwright-core';
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { restoreZOrder, sendToBottom } from './zorder.mjs';

const root = resolve(import.meta.dirname, '..');
const dataDir = resolve(root, '.test-data/click-regression');
rmSync(dataDir, { recursive: true, force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let app;
let appPid;
let page;
let passed = 0;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

function assert(condition, message, detail) {
  if (!condition) {
    console.error(`  FAIL ${message}`, detail ?? '');
    throw new Error(`断言失败：${message}`);
  }
  passed += 1;
  console.log(`  ok  ${message}`);
}

async function click(locator) {
  try {
    await locator.click({ timeout: 6000 });
  } catch (error) {
    const box = await locator.boundingBox();
    if (!box) throw error;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
}

async function waitActiveText(needle, timeout = 60000) {
  await page.waitForFunction(
    (text) => document.querySelector('.terminal-pane:not(.is-hidden) .xterm-rows')?.textContent.includes(text),
    needle,
    { timeout },
  );
}

async function findText(needle) {
  return page.evaluate((text) => {
    const pane = document.querySelector('.terminal-pane:not(.is-hidden)');
    const rows = pane?.querySelector('.xterm-rows');
    if (!rows) return null;
    const walker = document.createTreeWalker(rows, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = node.data.indexOf(text);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + text.length);
      const rect = range.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      return { left: rect.left, right: rect.right, y: rect.y + rect.height / 2 };
    }
    return null;
  }, needle);
}

async function terminalCenter() {
  const box = await page.locator('.terminal-pane:not(.is-hidden) .xterm-screen').boundingBox();
  return { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
}

try {
  app = await electron.launch({
    executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
    cwd: root,
    args: ['.', `--data-dir=${dataDir}`],
    env,
  });
  page = await app.firstWindow();
  appPid = app.process().pid;
  const pageErrors = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
    console.log('[pageerror]', error.message);
  });
  await page.locator('.app').waitFor();
  await wait(500);
  sendToBottom(appPid);

  await click(page.locator('.add-project-btn'));
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill('D:/project-demo/cmd-toolbox');
  await page.locator('#project-name').fill('Click Check');
  await click(page.getByRole('button', { name: '保存项目', exact: true }));
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await wait(400);
  await click(page.getByRole('button', { name: '打开命令提示符', exact: true }));
  await page.locator('.terminal-pane').waitFor();
  await waitActiveText('cmd-toolbox>', 60000);
  await page.locator('.terminal-pane:not(.is-hidden) .xterm-screen').click();

  console.log('1. CMD 点击不影响输入');
  await page.keyboard.type('for /L %i in (1,1,10) do @echo click-line-%i');
  await page.keyboard.press('Enter');
  await waitActiveText('click-line-10');
  await wait(500);
  const center = await terminalCenter();
  await page.mouse.click(center.x, center.y);
  await wait(300);
  await page.keyboard.type('echo cmd-click-typed');
  await page.keyboard.press('Enter');
  await waitActiveText('cmd-click-typed');
  assert(true, 'CMD 点击后仍可正常输入和执行');

  console.log('2. CMD 拖选文本仍可复制');
  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  const line = await findText('click-line-5');
  assert(Boolean(line), '找到用于拖选的输出行');
  await page.mouse.move(line.left + 1, line.y);
  await page.mouse.down();
  await page.mouse.move(line.right - 1, line.y, { steps: 8 });
  await page.mouse.up();
  await wait(300);
  await page.keyboard.press('Control+C');
  await wait(500);
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert(copied.includes('click-line-5'), '拖选后 Ctrl+C 复制到剪贴板', JSON.stringify(copied));
  await page.mouse.click(center.x, center.y);
  await wait(200);

  console.log('3. PowerShell 点击不影响输入');
  await click(page.locator('.new-terminal-caret'));
  await page.locator('.popup-item', { hasText: 'PowerShell' }).click();
  await waitActiveText('PS ', 40000);
  await wait(800);
  await page.locator('.terminal-pane:not(.is-hidden) .xterm-screen').click();
  await page.keyboard.type('echo ps-click-before');
  await page.keyboard.press('Enter');
  await waitActiveText('ps-click-before');
  await page.mouse.click(center.x, center.y);
  await wait(300);
  await page.keyboard.type('echo ps-click-after');
  await page.keyboard.press('Enter');
  await waitActiveText('ps-click-after');
  assert(true, 'PowerShell 点击后仍可正常输入和执行');

  assert(pageErrors.length === 0, '渲染进程无异常', pageErrors);
  console.log(`\n${passed} 项断言通过`);
} catch (error) {
  if (page) {
    console.log('failure text:', (await page.locator('.terminal-pane:not(.is-hidden) .xterm-rows').innerText().catch(() => 'n/a')).slice(-600));
  }
  throw error;
} finally {
  if (appPid) restoreZOrder(appPid);
  if (app) await app.close().catch(() => {});
  await wait(300);
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // the app may still hold the directory briefly
  }
}
