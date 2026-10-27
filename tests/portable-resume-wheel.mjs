import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const exe = resolve(root, 'release/CmdToolbox.exe');
const dataDir = resolve(root, '.test-data/portable-resume');
const port = 9334;

if (!existsSync(exe)) throw new Error(`找不到便携版程序：${exe}`);
rmSync(dataDir, { recursive: true, force: true });

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
      // still extracting / starting
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

const fingerprint = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

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
  await page.locator('#project-name').fill('Resume Wheel');
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
  await waitText(page, 'Grok', 120000).catch(() => console.log('未检测到 Grok 标题，继续尝试'));
  await wait(4500);

  await page.keyboard.type('/resume');
  await wait(1500);
  await page.keyboard.press('Enter');
  console.log('等待会话列表...');
  await waitText(page, 'nav', 30000).catch(() => console.log('未检测到 nav 提示'));
  await wait(1500);
  await page.keyboard.press('Enter');
  await wait(5000);

  const before = await rows(page);
  const box = await page.locator('.terminal-pane:not(.is-hidden) .xterm-screen').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let index = 0; index < 3; index += 1) await page.mouse.wheel(0, -480);
  await wait(1500);
  const afterUp = await rows(page);
  for (let index = 0; index < 3; index += 1) await page.mouse.wheel(0, 480);
  await wait(1500);
  const afterDown = await rows(page);

  console.log('before fingerprint:', fingerprint(before), 'chars:', before.length);
  console.log('up     fingerprint:', fingerprint(afterUp), 'chars:', afterUp.length);
  console.log('down   fingerprint:', fingerprint(afterDown), 'chars:', afterDown.length);
  console.log('packaged /resume wheel up changed:', before !== afterUp);
  console.log('packaged /resume wheel down changed:', afterUp !== afterDown);
  if (before === afterUp) throw new Error('便携版 /resume 滚轮向上未改变会话视图');
  if (afterUp === afterDown) throw new Error('便携版 /resume 滚轮向下未改变会话视图');

  console.log('\n便携版 /resume 滚轮上下验证通过');
} finally {
  if (browser) await browser.close().catch(() => {});
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
