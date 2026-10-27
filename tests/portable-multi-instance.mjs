import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { restoreZOrder, sendToBottom } from './zorder.mjs';

const root = resolve(import.meta.dirname, '..');
const exe = process.env.CMDTOOLBOX_EXE ? resolve(process.env.CMDTOOLBOX_EXE) : resolve(root, 'release/CmdToolbox.exe');
const dataDir = resolve(root, '.test-data/multi-instance');
const shots = resolve(root, 'test-shots');
const port = 9340;

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

async function waitText(page, needle, timeout = 40000) {
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

const first = spawn(exe, [`--data-dir=${dataDir}`, `--remote-debugging-port=${port}`], {
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
  sendToBottom(first.pid);

  await click(page, page.locator('.add-project-btn'));
  await page.locator('#project-path').fill('D:/project-demo/cmd-toolbox');
  await page.locator('#project-name').fill('Multi Instance');
  await click(page, page.getByRole('button', { name: '保存项目', exact: true }));
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await wait(400);
  await click(page, page.getByRole('button', { name: '打开命令提示符', exact: true }));
  await page.locator('.terminal-pane').waitFor();
  await waitText(page, 'cmd-toolbox>');
  const firstScreen = await rows(page);
  console.log('first terminal healthy:', !firstScreen.includes('伪终端不可用'));

  console.log('launching a second copy with the same data directory...');
  const second = spawn(exe, [`--data-dir=${dataDir}`], { stdio: 'ignore', windowsHide: false, env });
  const secondExit = await new Promise((done) => {
    const timer = setTimeout(() => done('timeout'), 90000);
    second.on('exit', (code) => {
      clearTimeout(timer);
      done(code);
    });
  });
  console.log('second copy exit:', secondExit);
  await wait(2000);

  if (page.isClosed()) throw new Error('第一个实例在第二次启动后被关闭或崩溃');
  await page.locator('.app').waitFor({ timeout: 20000 });
  await click(page, page.locator('.new-terminal-main'));
  await waitText(page, 'cmd-toolbox>', 30000).catch(() => {});
  await wait(1000);
  const screen = await rows(page);
  console.log('=== new terminal after second launch ===');
  console.log(screen);
  const pipeFallback = screen.includes('伪终端不可用');
  console.log('pipe notice after second launch:', pipeFallback);
  await page.screenshot({ path: resolve(shots, 'pty-multi-instance.png') });
  if (pipeFallback) throw new Error('第二个便携实例导致第一个实例的 PTY 降级');
  if (!screen.includes('cmd-toolbox>')) throw new Error('第二个实例启动后新终端没有正常提示符');

  await page.locator('.terminal-pane:not(.is-hidden) .xterm-screen').click();
  await page.keyboard.type('echo survived-second-launch');
  await page.keyboard.press('Enter');
  await waitText(page, 'survived-second-launch', 20000);
  const after = await rows(page);
  console.log('=== after typing ===');
  console.log(after);
  if (!after.includes('survived-second-launch')) throw new Error('新终端无法输入');
  console.log('双实例 PTY 回归验证通过');
} finally {
  if (browser) await browser.close().catch(() => {});
  restoreZOrder(first.pid);
  spawnSync('taskkill', ['/PID', String(first.pid), '/T', '/F'], { stdio: 'ignore' });
}
