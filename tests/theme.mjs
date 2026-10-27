import { _electron as electron } from 'playwright-core';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { restoreZOrder, sendToBottom } from './zorder.mjs';

const root = resolve(import.meta.dirname, '..');
const dataDir = resolve(root, '.test-data/theme');
const shots = resolve(root, 'test-shots');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });

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

async function launch() {
  app = await electron.launch({
    executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
    cwd: root,
    args: ['.', `--data-dir=${dataDir}`],
    env,
  });
  page = await app.firstWindow();
  appPid = app.process().pid;
  await page.locator('.app').waitFor();
  await wait(500);
  sendToBottom(appPid);
  return page;
}

async function bodyColor() {
  return page
    .locator('.terminal-pane:not(.is-hidden) .terminal-body')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
}

try {
  console.log('1. 默认深色终端');
  await launch();
  await click(page.locator('.add-project-btn'));
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill('D:/project-demo/cmd-toolbox');
  await page.locator('#project-name').fill('Theme Check');
  await click(page.getByRole('button', { name: '保存项目', exact: true }));
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await wait(400);
  await click(page.getByRole('button', { name: '打开命令提示符', exact: true }));
  await page.locator('.terminal-pane').waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector('.terminal-pane:not(.is-hidden) .xterm-rows')
        ?.textContent.includes('cmd-toolbox>'),
    null,
    { timeout: 60000 },
  );

  assert(
    (await page.locator('.terminal-pane.theme-dark').count()) === 1,
    '新终端默认使用深色主题',
  );
  assert(
    (await page.evaluate(() => localStorage.getItem('cmd-toolbox.terminal-theme'))) === 'dark',
    '默认配色写入持久化存储',
  );
  assert((await bodyColor()) === 'rgb(12, 12, 12)', '终端内容区为纯黑底');

  console.log('2. Grok 终端主题环境');
  await click(page.locator('.terminal-pane:not(.is-hidden) .xterm-screen'));
  await page.keyboard.type('set GROK_THEME & set GROK_TERMINAL_THEME');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => {
      const rows = document.querySelector('.terminal-pane:not(.is-hidden) .xterm-rows')?.textContent || '';
      return rows.includes('GROK_THEME=terminal') && rows.includes('GROK_TERMINAL_THEME=1');
    },
    null,
    { timeout: 8000 },
  );
  assert(true, 'CMD 环境已开启 Grok 终端主题');
  await page.keyboard.type('cls');
  await page.keyboard.press('Enter');
  await wait(250);

  console.log('3. 页签关闭按钮几何居中');
  const closeGeometry = await page.locator('.tab.active .tab-close').evaluate((button) => {
    const svg = button.querySelector('svg');
    const buttonRect = button.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const style = getComputedStyle(button);
    return {
      dx: (buttonRect.left + buttonRect.right) / 2 - (svgRect.left + svgRect.right) / 2,
      dy: (buttonRect.top + buttonRect.bottom) / 2 - (svgRect.top + svgRect.bottom) / 2,
      buttonSize: [buttonRect.width, buttonRect.height],
      svgSize: [svgRect.width, svgRect.height],
      padding: style.padding,
    };
  });
  console.log('  geometry', JSON.stringify(closeGeometry));
  assert(Math.abs(closeGeometry.dx) <= 0.5, '关闭按钮 X 水平居中');
  assert(Math.abs(closeGeometry.dy) <= 0.5, '关闭按钮 X 垂直居中');
  assert(closeGeometry.padding === '0px', '关闭按钮无默认内边距干扰');
  await page.screenshot({ path: resolve(shots, 'theme-01-dark.png') });
  await page.locator('.tab.active').screenshot({ path: resolve(shots, 'theme-02-tab-dark.png') });

  console.log('3b. 侧边栏加号几何居中');
  const plusGeometry = await page.evaluate(() => {
    const measure = (selector) => {
      const button = document.querySelector(selector);
      if (!button) return null;
      const svg = button.querySelector('svg');
      const buttonRect = button.getBoundingClientRect();
      const svgRect = svg.getBoundingClientRect();
      return {
        dx: (buttonRect.left + buttonRect.right) / 2 - (svgRect.left + svgRect.right) / 2,
        dy: (buttonRect.top + buttonRect.bottom) / 2 - (svgRect.top + svgRect.bottom) / 2,
        padding: getComputedStyle(button).padding,
      };
    };
    return {
      section: measure('.section-add'),
      quick: measure('.group-quick-add'),
    };
  });
  console.log('  geometry', JSON.stringify(plusGeometry));
  for (const [name, geometry] of Object.entries(plusGeometry)) {
    assert(geometry !== null, `${name} 加号存在`);
    assert(Math.abs(geometry.dx) <= 0.5, `${name} 加号水平居中`);
    assert(Math.abs(geometry.dy) <= 0.5, `${name} 加号垂直居中`);
    assert(geometry.padding === '0px', `${name} 加号无默认内边距干扰`);
  }

  console.log('4. 切换浅色并实时生效');
  await click(page.locator('.theme-option[title="浅色终端"]'));
  await wait(250);
  assert(
    (await page.locator('.terminal-pane.theme-light').count()) === 1,
    '面板即时切换为浅色',
  );
  assert((await bodyColor()) === 'rgb(255, 255, 255)', '终端内容区即时变为白底');
  assert(
    (await page.evaluate(() => localStorage.getItem('cmd-toolbox.terminal-theme'))) === 'light',
    '浅色选择已持久化',
  );
  assert(
    (await page.locator('.theme-option[title="浅色终端"]').getAttribute('aria-pressed')) === 'true',
    '浅色选项显示为选中态',
  );
  await page.screenshot({ path: resolve(shots, 'theme-03-light.png') });
  await page.locator('.tab.active').screenshot({ path: resolve(shots, 'theme-04-tab-light.png') });

  console.log('5. 重启后保持浅色');
  restoreZOrder(appPid);
  await app.close();
  app = null;
  await launch();
  assert(
    (await page.evaluate(() => localStorage.getItem('cmd-toolbox.terminal-theme'))) === 'light',
    '重启后读取到浅色设置',
  );

  console.log('6. 切回深色');
  await click(page.locator('.theme-option[title="深色终端"]'));
  await wait(200);
  assert(
    (await page.evaluate(() => localStorage.getItem('cmd-toolbox.terminal-theme'))) === 'dark',
    '深色选择已持久化',
  );

  console.log(`\n全部通过：${passed} 项断言`);
} finally {
  if (app) {
    restoreZOrder(appPid);
    await app.close().catch(() => {});
  }
}
