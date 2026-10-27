import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { restoreZOrder, sendToBottom } from './zorder.mjs';

const root = resolve(import.meta.dirname, '..');
const exe = process.env.CMDTOOLBOX_EXE ? resolve(process.env.CMDTOOLBOX_EXE) : resolve(root, 'release/CmdToolbox.exe');
const dataDir = resolve(root, '.test-data/portable-grok-wheel-lines');
const outDir = resolve(root, '.test-data/portable-grok-wheel-lines-out');
const port = 9359;

if (!existsSync(exe)) throw new Error(`找不到便携版程序：${exe}`);
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let browser;
let page;
const child = spawn(exe, [`--data-dir=${dataDir}`, `--remote-debugging-port=${port}`], {
  stdio: 'ignore',
  windowsHide: false,
  env,
});

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

async function rows() {
  return page.locator('.terminal-pane:not(.is-hidden) .xterm-rows').innerText();
}

function shift(before, after) {
  const a = before.split('\n').map((line) => line.replace(/\s+$/, ''));
  const b = after.split('\n').map((line) => line.replace(/\s+$/, ''));
  let best = { offset: 0, matches: 0 };
  for (let offset = -6; offset <= 6; offset += 1) {
    let matches = 0;
    for (let index = 0; index < b.length; index += 1) {
      const source = index + offset;
      if (source < 0 || source >= a.length) continue;
      if (a[source] === b[index] && a[source].trim()) matches += 1;
    }
    if (matches > best.matches || (matches === best.matches && matches > 0 && Math.abs(offset) < Math.abs(best.offset))) {
      best = { offset, matches };
    }
  }
  return best;
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
  page.on('pageerror', (error) => console.log('[pageerror]', error.message));
  await page.locator('.app').waitFor();
  await wait(600);
  sendToBottom(child.pid);

  await click(page.locator('.add-project-btn'));
  await page.locator('#project-path').fill('E:/phpstudy_pro/WWW/web-7.0');
  await page.locator('#project-name').fill('Portable Wheel');
  await click(page.getByRole('button', { name: '保存项目', exact: true }));
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await wait(400);
  await click(page.getByRole('button', { name: '打开命令提示符', exact: true }));
  await page.locator('.terminal-pane').waitFor();
  await waitActiveText('web-7.0>', 60000);
  await page.locator('.terminal-pane:not(.is-hidden) .xterm-screen').click();

  const promptBefore = await rows();
  const promptBox = await page.locator('.terminal-pane:not(.is-hidden) .xterm-screen').boundingBox();
  await page.mouse.move(promptBox.x + promptBox.width / 2, promptBox.y + promptBox.height / 2);
  await page.mouse.wheel(0, -100);
  await wait(500);
  const promptAfter = await rows();
  if (promptBefore !== promptAfter) throw new Error('空 CMD 提示符滚轮产生了可见副作用');
  console.log('ok 空 CMD 滚轮无副作用');

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

  const box = await page.locator('.terminal-pane:not(.is-hidden) .xterm-screen').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45);

  const snap = async (label) => {
    const text = await rows();
    writeFileSync(resolve(outDir, `${label}.txt`), text, 'utf8');
    return text;
  };

  const wheelOnce = async (deltaY) => {
    await page.mouse.wheel(0, deltaY);
    await wait(500);
  };

  const baseline = await snap('baseline');
  const results = [];
  let previous = baseline;
  for (let i = 1; i <= 2; i += 1) {
    await wheelOnce(-100);
    const text = await snap(`up-${i}`);
    results.push({ gesture: `up-${i}`, ...shift(previous, text) });
    previous = text;
  }
  for (let i = 1; i <= 2; i += 1) {
    await wheelOnce(100);
    const text = await snap(`down-${i}`);
    results.push({ gesture: `down-${i}`, ...shift(previous, text) });
    previous = text;
  }

  console.log('gestures:', JSON.stringify(results));
  const ups = results.filter((item) => item.gesture.startsWith('up'));
  const downs = results.filter((item) => item.gesture.startsWith('down'));
  if (!ups.every((item) => item.offset === -1 && item.matches >= 3) ||
      !downs.every((item) => item.offset === 1 && item.matches >= 3)) {
    throw new Error('便携版滚轮没有逐行滚动');
  }

  await page.screenshot({ path: resolve(outDir, 'grok-wheel.png') });
  writeFileSync(resolve(outDir, 'gestures.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log('PASS 便携版每格滚轮正好一行');
} catch (error) {
  if (page) {
    console.log('visible rows:', JSON.stringify(await rows().catch(() => 'n/a')));
    await page.screenshot({ path: resolve(outDir, 'failure.png') }).catch(() => {});
  }
  throw error;
} finally {
  try { await browser?.close(); } catch {}
  restoreZOrder(child.pid);
  killApp();
  try { child.kill(); } catch {}
  await wait(800);
}
