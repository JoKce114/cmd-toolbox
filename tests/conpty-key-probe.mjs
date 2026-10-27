import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const exe = resolve(root, 'release/CmdToolbox.exe');
const dataDir = resolve(root, '.test-data/conpty-key-reader');
const port = 9351;

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

  await click(page, page.locator('.add-project-btn'));
  await page.locator('#project-path').fill('E:/phpstudy_pro/WWW/web-7.0');
  await page.locator('#project-name').fill('ConPTY Key Reader');
  await click(page, page.getByRole('button', { name: '保存项目', exact: true }));
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await wait(400);
  await click(page, page.getByRole('button', { name: '打开命令提示符', exact: true }));
  await page.locator('.terminal-pane').waitFor();
  await waitText(page, 'web-7.0>', 60000);
  await page.locator('.terminal-pane:not(.is-hidden) .xterm-screen').click();

  await page.keyboard.type(
    'powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File D:\\project-demo\\cmd-toolbox\\tests\\conpty-key-reader.ps1',
  );
  await page.keyboard.press('Enter');
  await waitText(page, '初始化', 4000).catch(() => {});
  await wait(3000);

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
  if (!sid) throw new Error('无法从渲染层取得 sessionId');

  let seenMax = 0;
  async function readKeys() {
    const text = await rows(page);
    const hits = [];
    for (const line of text.split('\n')) {
      const match = line.trim().match(/^(KEY|ERR) #(\d+) (.*)$/);
      if (!match) continue;
      const id = Number(match[2]);
      if (id <= seenMax) continue;
      hits.push(`${match[1]}#${id} ${match[3]}`);
      seenMax = Math.max(seenMax, id);
    }
    return hits;
  }

  async function raw(label, data) {
    await readKeys();
    await page.evaluate(([id, payload]) => window.api.pty.write(id, payload), [sid, data]);
    await wait(1100);
    const fresh = await readKeys();
    const summary = fresh.length ? fresh.join(' | ') : seenMax ? '(无新按键输出)' : '(读取器未就绪)';
    console.log(`${label.padEnd(30)} ${summary}`);
  }

  await raw('CR 0x0D', '\r');
  await raw('LF 0x0A', '\n');
  await raw('Ctrl+K 0x0B', '\x0b');
  await raw('Ctrl+U 0x15', '\x15');
  await raw('Alt+J ESC j', '\x1bj');
  await raw('Kitty Ctrl+J 106;5u', '\x1b[106;5u');
  await raw('Kitty C+J press 106;5:1u', '\x1b[106;5:1u');
  await raw('Kitty C+S+J 106;6u', '\x1b[106;6u');
  await raw('Kitty Ctrl+Enter 13;5u', '\x1b[13;5u');
  await raw('modifyOtherKeys 27;5;106~', '\x1b[27;5;106~');
  await raw('win32 Ctrl+J', '\x1b[74;36;10;1;8;1_');
  await raw('win32 Ctrl+J uc0', '\x1b[74;36;0;1;8;1_');
  await raw('win32 Ctrl+J cs=12', '\x1b[74;36;10;1;12;1_');
  await raw('CSI 106;5~', '\x1b[106;5~');
  await raw('SS3 j', '\x1bOj');
  await raw('ESC LF', '\x1b\x0a');
  await raw('Ctrl+Shift+J xterm', '');
} finally {
  if (browser) await browser.close().catch(() => {});
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
