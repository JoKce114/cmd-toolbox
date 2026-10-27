import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const exe = resolve(root, 'release/CmdToolbox.exe');
const dataDir = resolve(root, '.test-data/grok-win32-input');
const shots = resolve(root, 'test-shots');
const port = 9348;

if (!existsSync(exe)) throw new Error(`找不到便携版程序：${exe}`);
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(resolve(root, '.test-data'), { recursive: true });

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

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

async function rows(page) {
  return page.locator('.terminal-pane:not(.is-hidden) .xterm-rows').innerText();
}

async function waitText(page, needle, timeout = 60000) {
  await page.waitForFunction(
    (text) => document.querySelector('.terminal-pane:not(.is-hidden) .xterm-rows')?.textContent.includes(text),
    needle,
    { timeout },
  );
}

async function click(page, locator) {
  try {
    await locator.click({ timeout: 6000 });
  } catch (error) {
    const box = await locator.boundingBox();
    if (!box) throw error;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
}

function screenLines(text) {
  return text.split('\n').map((line) => line.replace(/\s+$/, ''));
}

function bestShift(before, after) {
  const a = screenLines(before);
  const b = screenLines(after);
  let best = { offset: 0, matches: 0 };
  for (let offset = -a.length; offset <= a.length; offset += 1) {
    let matches = 0;
    for (let index = 0; index < b.length; index += 1) {
      const source = index + offset;
      if (source < 0 || source >= a.length) continue;
      if (a[source] === b[index] && a[source].trim()) matches += 1;
    }
    if (matches > best.matches) best = { offset, matches };
  }
  return best;
}

const child = spawn(exe, [`--data-dir=${dataDir}`, `--remote-debugging-port=${port}`], {
  stdio: 'ignore',
  windowsHide: false,
  env,
});

let browser;
try {
  await waitForCdp();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || (await context.waitForEvent('page', { timeout: 20000 }));
  await page.locator('.app').waitFor({ timeout: 20000 });
  await wait(600);

  await page.evaluate(() => {
    window.__ptyLog = [];
    window.api.pty.onData((id, data) => {
      window.__ptyLog.push(data);
      if (window.__ptyLog.length > 4000) window.__ptyLog.splice(0, 2000);
    });
  });

  await click(page, page.locator('.add-project-btn'));
  await page.locator('#project-path').fill('E:/phpstudy_pro/WWW/web-7.0');
  await page.locator('#project-name').fill('Grok Win32 Input');
  await click(page, page.getByRole('button', { name: '保存项目', exact: true }));
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await wait(400);
  await click(page, page.getByRole('button', { name: '打开命令提示符', exact: true }));
  await page.locator('.terminal-pane').waitFor();
  await waitText(page, 'web-7.0>', 60000);
  await page.locator('.terminal-pane:not(.is-hidden) .xterm-screen').click();

  await page.keyboard.type('grok');
  await page.keyboard.press('Enter');
  console.log('grok 启动中...');
  await waitText(page, 'Grok', 120000).catch(() => console.log('未检测到 Grok 标题'));
  await wait(4500);
  await page.keyboard.type('/resume');
  await wait(1500);
  await page.keyboard.press('Enter');
  await waitText(page, 'nav', 30000);
  await wait(1500);
  await page.keyboard.press('Enter');
  await wait(6000);

  const sid = await page.evaluate(() => {
    const pane = document.querySelector('.terminal-pane:not(.is-hidden)');
    if (!pane) return '';
    const key = Object.keys(pane).find((name) => name.startsWith('__reactFiber$'));
    let fiber = key ? pane[key] : null;
    while (fiber) {
      const props = fiber.memoizedProps;
      if (props && props.tab && typeof props.tab.sessionId === 'string') return props.tab.sessionId;
      fiber = fiber.return;
    }
    return '';
  });
  console.log('sessionId:', sid || '(未找到)');
  if (!sid) throw new Error('无法从渲染层取得 sessionId');

  const logText = await page.evaluate(() => (window.__ptyLog || []).join(''));
  const modes = ['?9001h', '?1000h', '?1002h', '?1003h', '?1006h', '?2004h'];
  console.log('启动输出模式检测：');
  for (const mode of modes) {
    console.log(`  ${mode.padEnd(8)} ${logText.includes(mode) ? '已启用' : '未出现'}`);
  }

  async function raw(label, data) {
    const before = await rows(page);
    await page.evaluate(([id, payload]) => window.api.pty.write(id, payload), [sid, data]);
    await wait(900);
    const after = await rows(page);
    const shift = bestShift(before, after);
    console.log(`${label.padEnd(28)} changed=${before !== after} shift=${shift.offset} matches=${shift.matches}`);
    await page.screenshot({ path: resolve(shots, `grok-win32-${label.replace(/[^a-zA-Z0-9]+/g, '-')}.png`) });
  }

  const keyRecord = (vk, sc, uc, cs = 8, up = false) => `\x1b[${vk};${sc};${uc};${up ? 0 : 1};${cs};1_`;
  const ctrlJ = keyRecord(74, 36, 10);
  const ctrlK = keyRecord(75, 37, 11);

  await raw('prompt-win32-ctrl-j', ctrlJ);
  await raw('prompt-win32-ctrl-k', ctrlK);

  await page.keyboard.press('Tab');
  await wait(900);
  await page.screenshot({ path: resolve(shots, 'grok-win32-scrollback.png') });
  await raw('scrollback-win32-ctrl-k', ctrlK);
  await raw('scrollback-win32-ctrl-j', ctrlJ);
  await raw('scrollback-win32-ctrl-j-updown', ctrlJ + keyRecord(74, 36, 10, 8, true));
  await raw('scrollback-win32-ctrl-j-uc0', keyRecord(74, 36, 0));
  await raw('scrollback-win32-ctrl-j-rightctr', keyRecord(74, 36, 10, 4));
  await raw('scrollback-legacy-ctrl-j', '\n');
  await raw('scrollback-win32-ctrl-k-uc0', keyRecord(75, 37, 0));
} finally {
  if (browser) await browser.close().catch(() => {});
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
