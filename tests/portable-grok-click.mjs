import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { restoreZOrder, sendToBottom } from './zorder.mjs';

const root = resolve(import.meta.dirname, '..');
const exe = process.env.CMDTOOLBOX_EXE ? resolve(process.env.CMDTOOLBOX_EXE) : resolve(root, 'release/CmdToolbox.exe');
const dataDir = resolve(root, '.test-data/portable-grok-click');
const port = 9361;

if (!existsSync(exe)) throw new Error(`找不到便携版程序：${exe}`);
rmSync(dataDir, { recursive: true, force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

let passed = 0;
function assert(condition, message, detail) {
  if (!condition) throw new Error(`断言失败：${message} ${detail ?? ''}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const child = spawn(exe, [`--data-dir=${dataDir}`, `--remote-debugging-port=${port}`], {
  stdio: 'ignore',
  windowsHide: false,
  env,
});

let browser;
let page;

async function waitForCdp(timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // extracting / starting
    }
    await wait(750);
  }
  throw new Error('便携版启动超时');
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
    const text = rows?.textContent ?? '';
    const rect = screen?.getBoundingClientRect();
    return {
      screen: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      markers: {
        dashboard: text.includes('[Dashboard]'),
        newAgent: text.includes('New Agent'),
        dispatch: text.includes('Dispatch'),
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
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    return null;
  }, label);
}

function killApp() {
  spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', `
$port = ${port}
$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'Cmd Toolbox*' -and $_.CommandLine -like "*--remote-debugging-port=$port*" }
foreach ($p in $procs) { taskkill /PID $p.ProcessId /T /F | Out-Null }
`], { timeout: 30000 });
}

try {
  await waitForCdp();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  page = context.pages()[0] || (await context.waitForEvent('page', { timeout: 20000 }));
  const pageErrors = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
    console.log('[pageerror]', error.message);
  });
  await page.locator('.app').waitFor();
  await wait(600);
  sendToBottom(child.pid);

  await click(page.locator('.add-project-btn'));
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill('E:/phpstudy_pro/WWW/web-7.0');
  await page.locator('#project-name').fill('Portable Click');
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

  const before = await info();
  assert(before.markers.dashboard, '便携版会话显示 [Dashboard]');
  const dashboard = await findButton('[Dashboard]');
  assert(Boolean(dashboard), '便携版 [Dashboard] 可点击');

  const screen = before.screen;
  await page.mouse.move(screen.x + screen.width * 0.5, screen.y + screen.height * 0.4);
  for (let index = 0; index < 3; index += 1) await page.mouse.wheel(0, -100);
  await wait(900);
  assert((await info()).markers.arrow, '便携版上翻后出现 ▼ 箭头');
  const arrow = await findButton('▼');
  assert(Boolean(arrow), '便携版 ▼ 箭头可定位');
  await page.mouse.click(arrow.x, arrow.y);
  await wait(1200);
  assert(!(await info()).markers.arrow, '便携版点击箭头回到最新');

  const freshDashboard = await findButton('[Dashboard]');
  assert(Boolean(freshDashboard), '便携版跳转后 [Dashboard] 仍存在');
  await page.mouse.click(freshDashboard.x, freshDashboard.y);
  await wait(1500);
  const after = await info();
  assert(!after.markers.dashboard && after.markers.newAgent && after.markers.dispatch, '便携版点击进入仪表盘');
  assert(pageErrors.length === 0, '便携版渲染进程无异常', pageErrors);

  console.log(`\n${passed} 项断言通过`);
} catch (error) {
  if (page) console.log('failure markers:', JSON.stringify(await info().catch(() => 'n/a')));
  throw error;
} finally {
  try { await browser?.close(); } catch {}
  restoreZOrder(child.pid);
  killApp();
  try { child.kill(); } catch {}
  await wait(800);
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // the app may still hold the directory briefly
  }
}
