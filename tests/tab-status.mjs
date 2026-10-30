// AI 页签状态灯与「已完成未读」标记。
// 用真实的 AI CLI 页签产生输出，再主动结束会话触发「跑完」，
// 不依赖 AI 持续输出的节奏，避免测试抖动。
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-status-'));

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.CMDTOOLBOX_NO_UPDATE = '1';

const app = await electron.launch({
  executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
  cwd: root,
  args: ['.', `--data-dir=${dataDir}`],
  env,
});

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.app').waitFor();
  await page.waitForTimeout(1000);

  await page.locator('.add-project-btn').click();
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill('D:/project-demo/cmd-toolbox');
  await page.locator('#project-name').fill('status-proj');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await page.waitForTimeout(400);
  await page.locator('.group-main', { hasText: 'status-proj' }).click();
  await page.waitForTimeout(400);

  console.log('1. 普通终端页签没有状态灯');
  await page.locator('.new-terminal-main').first().click();
  await page.waitForTimeout(2500);
  assert((await page.locator('.tab-lamp').count()) === 0, '命令提示符页签不显示状态灯');

  console.log('2. 打开 AI 页签后出现状态灯');
  await page.locator('.new-terminal-caret').first().click();
  await page.waitForTimeout(300);
  await page.locator('.popup-menu').getByText('Claude', { exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tab-lamp').length > 0, null, {
    timeout: 60000,
  });
  const lampClass = await page.locator('.tab-lamp').first().getAttribute('class');
  assert(
    /is-(running|waiting|error|idle)/.test(lampClass || ''),
    `状态灯带有具体状态类，实际 ${lampClass}`,
  );

  console.log('3. 切到别的页签后结束 AI 任务 → 标记未读');
  await page.locator('.tab').first().click();
  await page.waitForTimeout(500);
  await page.evaluate(() => window.api.pty.resetAll());
  await page.waitForTimeout(2500);
  const unread = await page.locator('.tab-lamp.is-unread').count();
  assert(unread > 0, `未读标记出现在页签上，实际 ${unread} 个`);

  const groupUnread = await page.locator('.group-lamp.is-unread').count();
  assert(groupUnread > 0, `侧栏项目行同步显示未读，实际 ${groupUnread} 个`);

  console.log('4. 点开该页签后未读消失');
  await page.locator('.tab', { has: page.locator('.tab-lamp.is-unread') }).first().click();
  await page.waitForTimeout(800);
  assert(
    (await page.locator('.tab-lamp.is-unread').count()) === 0,
    '切到该页签后页签未读清除',
  );
  assert(
    (await page.locator('.group-lamp.is-unread').count()) === 0,
    '切到该页签后侧栏未读也清除',
  );

  await page.screenshot({ path: 'test-shots/tab-status.png' });
} finally {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n全部通过：${passed} 项`);
