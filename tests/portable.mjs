import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { restoreZOrder, sendToBottom } from './zorder.mjs';

const root = resolve(import.meta.dirname, '..');
const exe = process.env.CMDTOOLBOX_EXE ? resolve(process.env.CMDTOOLBOX_EXE) : resolve(root, 'release/CmdToolbox.exe');
const dataDir = resolve(root, '.test-data/portable-run');
const shots = resolve(root, 'test-shots');
const port = 9333;

if (!existsSync(exe)) throw new Error(`找不到便携版程序：${exe}`);
rmSync(dataDir, { recursive: true, force: true });

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

async function waitForCdp(timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      // still extracting / starting
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 750));
  }
  throw new Error('便携版启动超时');
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(exe, [`--data-dir=${dataDir}`, `--remote-debugging-port=${port}`], {
  stdio: 'ignore',
  windowsHide: false,
  env,
});

let browser;
try {
  console.log('1. 启动便携 exe（自解压）');
  const version = await waitForCdp();
  console.log(`  CDP ${version['Browser'] || ''}`.trim());
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || (await context.waitForEvent('page', { timeout: 20000 }));
  await page.locator('.app').waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  sendToBottom(child.pid);
  assert((await page.locator('.boot-screen').count()) === 0, '便携版主界面正常加载');
  assert((await page.locator('.sidebar').innerText()).includes('全局终端'), '便携版内置全局终端');
  console.log('  window title:', await page.title());

  console.log('2. 便携版真实终端');
  await page.locator('.add-project-btn').click();
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill('D:/project-demo/cmd-toolbox');
  await page.locator('#project-name').fill('Portable Demo');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '打开命令提示符', exact: true }).click();
  await page.locator('.terminal-pane').waitFor();
  await page.waitForFunction(
    () => document.querySelector('.terminal-pane:not(.is-hidden) .xterm-rows')?.textContent.includes('cmd-toolbox>'),
    undefined,
    { timeout: 15000 },
  );
  await page.locator('.terminal-pane:not(.is-hidden) .xterm-screen').click();
  await page.keyboard.type('echo portable-exe-ok');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('.terminal-pane:not(.is-hidden) .xterm-rows')?.textContent.includes('portable-exe-ok'),
    undefined,
    { timeout: 15000 },
  );
  const paneText = await page.locator('.terminal-pane:not(.is-hidden) .xterm-rows').innerText();
  assert(!paneText.includes('伪终端不可用'), '便携版使用真实 PTY（未降级为管道模式）');
  assert(true, '便携版 node-pty 正常回显');
  assert(await page.locator('.tab').first().innerText().then((t) => t.includes('Portable Demo')), '便携版页签显示项目名');
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(shots, '18-portable-terminal.png') });

  await page.keyboard.type('set GROK_THEME & set GROK_TERMINAL_THEME');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => {
      const rows = document.querySelector('.terminal-pane:not(.is-hidden) .xterm-rows')?.textContent || '';
      return rows.includes('GROK_THEME=terminal') && rows.includes('GROK_TERMINAL_THEME=1');
    },
    undefined,
    { timeout: 8000 },
  );
  assert(true, '便携版终端已启用 Grok 终端主题');

  await browser.close().catch(() => {});
  browser = null;
  await new Promise((resolveWait) => setTimeout(resolveWait, 2500));

  const saved = JSON.parse(readFileSync(resolve(dataDir, 'projects.json'), 'utf8'));
  assert(saved.projects.some((project) => project.name === 'Portable Demo'), '便携版数据写入独立目录并持久化');
  console.log(`\n便携版全部通过：${passed} 项断言`);
} finally {
  if (browser) await browser.close().catch(() => {});
  restoreZOrder(child.pid);
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
