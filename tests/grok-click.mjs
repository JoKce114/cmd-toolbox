import { _electron as electron } from 'playwright-core';
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { restoreZOrder, sendToBottom } from './zorder.mjs';

const root = resolve(import.meta.dirname, '..');
const dataDir = resolve(root, '.test-data/grok-click');
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

async function info() {
  return page.evaluate(() => {
    const pane = document.querySelector('.terminal-pane:not(.is-hidden)');
    const rows = pane?.querySelector('.xterm-rows');
    const screen = pane?.querySelector('.xterm-screen');
    const viewport = pane?.querySelector('.xterm-viewport');
    const text = rows?.textContent ?? '';
    const screenRect = screen?.getBoundingClientRect();
    return {
      viewport: viewport
        ? {
            scrollTop: Math.round(viewport.scrollTop),
            scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight,
          }
        : null,
      screen: screenRect
        ? { x: screenRect.x, y: screenRect.y, width: screenRect.width, height: screenRect.height }
        : null,
      rows: rows ? rows.children.length : 0,
      markers: {
        dashboard: text.includes('[Dashboard]'),
        newAgent: text.includes('New Agent'),
        dispatch: text.includes('Dispatch'),
        recap: text.includes('Recap'),
        arrow: text.includes('▼'),
      },
    };
  });
}

async function findButton(label) {
  return page.evaluate((needle) => {
    const pane = document.querySelector('.terminal-pane:not(.is-hidden)');
    const rows = pane?.querySelector('.xterm-rows');
    if (!rows) return null;
    const walker = document.createTreeWalker(rows, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = node.data.indexOf(needle);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      const rect = range.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        width: rect.width,
        height: rect.height,
      };
    }
    return null;
  }, label);
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
  await page.locator('#project-path').fill('E:/phpstudy_pro/WWW/web-7.0');
  await page.locator('#project-name').fill('Grok Click');
  await click(page.getByRole('button', { name: '保存项目', exact: true }));
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await wait(400);
  await click(page.getByRole('button', { name: '打开命令提示符', exact: true }));
  await page.locator('.terminal-pane').waitFor();
  await waitActiveText('web-7.0>', 60000);
  await page.locator('.terminal-pane:not(.is-hidden) .xterm-screen').click();

  await page.keyboard.type('grok');
  await page.keyboard.press('Enter');
  console.log('grok 启动中...');
  await waitActiveText('Grok', 120000).catch(() => console.log('未检测到 Grok 标题'));
  await wait(4500);
  await page.keyboard.type('/resume');
  await wait(1500);
  await page.keyboard.press('Enter');
  await waitActiveText('nav', 30000);
  await wait(1500);
  await page.keyboard.press('Enter');
  await wait(6000);
  await page.keyboard.press('Tab');
  await wait(1000);

  console.log('1. 会话头部 [Dashboard] 可点击');
  const before = await info();
  assert(before.markers.dashboard, '会话中显示 [Dashboard]');
  const dashboard = await findButton('[Dashboard]');
  assert(Boolean(dashboard), '[Dashboard] 位置可定位');

  console.log('2. 上翻出现跳转箭头，点击回到最新');
  const screen = before.screen;
  await page.mouse.move(screen.x + screen.width * 0.5, screen.y + screen.height * 0.4);
  for (let index = 0; index < 3; index += 1) await page.mouse.wheel(0, -100);
  await wait(900);
  const scrolled = await info();
  assert(scrolled.markers.arrow, '上翻后出现 ▼ 跳转箭头');
  const arrow = await findButton('▼');
  assert(Boolean(arrow), '▼ 箭头位置可定位');
  await page.mouse.click(arrow.x, arrow.y);
  await wait(1200);
  const jumped = await info();
  assert(!jumped.markers.arrow, '点击箭头后回到最新位置，箭头消失');
  assert(jumped.markers.dashboard, '跳转后仍在会话中');

  console.log('3. 点击 [Dashboard] 进入仪表盘');
  const freshDashboard = await findButton('[Dashboard]');
  assert(Boolean(freshDashboard), '跳转后 [Dashboard] 仍可定位');
  await page.mouse.click(freshDashboard.x, freshDashboard.y);
  await wait(1500);
  const dashboardView = await info();
  assert(!dashboardView.markers.dashboard, '点击后离开会话头部');
  assert(dashboardView.markers.newAgent && dashboardView.markers.dispatch, '进入 Agent 仪表盘');
  assert(pageErrors.length === 0, '渲染进程无异常', pageErrors);

  console.log(`\n${passed} 项断言通过`);
} catch (error) {
  if (page) console.log('failure markers:', JSON.stringify(await info().catch(() => 'n/a')));
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
