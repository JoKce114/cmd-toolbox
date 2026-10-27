import { _electron as electron } from 'playwright-core';
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { restoreZOrder, sendToBottom } from './zorder.mjs';

const root = resolve(import.meta.dirname, '..');
const dataDir = resolve(root, '.test-data/wheel-regression');
const shots = resolve(root, 'test-shots');
rmSync(dataDir, { recursive: true, force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let app;
let appPid;
let currentPage;
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

async function click(page, locator) {
  try {
    await locator.click({ timeout: 6000 });
  } catch (error) {
    const box = await locator.boundingBox();
    if (!box) throw error;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
}

async function waitActiveText(page, needle, timeout = 30000) {
  await page.waitForFunction(
    (text) => {
      const pane = document.querySelector('.terminal-pane:not(.is-hidden)');
      return Boolean(pane?.querySelector('.xterm-rows')?.textContent.includes(text));
    },
    needle,
    { timeout },
  );
}

async function state(page) {
  return page.evaluate(() => {
    const pane = document.querySelector('.terminal-pane:not(.is-hidden)');
    const rows = pane?.querySelector('.xterm-rows')?.innerText ?? '';
    const viewport = pane?.querySelector('.xterm-viewport');
    const scrollable = pane?.querySelector('.xterm-scrollable-element');
    const scrollbar = scrollable?.querySelector('.scrollbar');
    return {
      rows,
      scrollTop: viewport ? Math.round(viewport.scrollTop) : null,
      scrollHeight: viewport?.scrollHeight ?? null,
      clientHeight: viewport?.clientHeight ?? null,
      scrollbar: scrollbar?.getAttribute('style') ?? null,
      list: (() => {
        const match = rows.match(/scroll-line-\d+/g);
        return match ? match.slice(0, 40) : [];
      })(),
    };
  });
}

async function wheel(page, deltaY, times = 3) {
  const box = await page.locator('.terminal-pane:not(.is-hidden) .xterm-screen').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let index = 0; index < times; index += 1) await page.mouse.wheel(0, deltaY);
  await wait(700);
}

try {
  app = await electron.launch({
    executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
    cwd: root,
    args: ['.', `--data-dir=${dataDir}`],
    env,
  });
  const page = await app.firstWindow();
  appPid = app.process().pid;
  page.on('pageerror', (error) => console.log('[pageerror]', error.message));
  currentPage = page;
  await page.locator('.app').waitFor();
  await wait(500);
  sendToBottom(appPid);

  await click(page, page.locator('.add-project-btn'));
  await page.locator('#project-path').fill('D:/project-demo/cmd-toolbox');
  await page.locator('#project-name').fill('Wheel Check');
  await click(page, page.getByRole('button', { name: '保存项目', exact: true }));
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await wait(400);
  await click(page, page.getByRole('button', { name: '打开命令提示符', exact: true }));
  await page.locator('.terminal-pane').waitFor();
  await waitActiveText(page, 'cmd-toolbox>', 40000);
  await page.locator('.terminal-pane:not(.is-hidden) .xterm-screen').click();

  console.log('1. CMD 输出 80 行后滚轮滚动本地回滚');
  await page.keyboard.type('for /L %i in (1,1,80) do @echo scroll-line-%i');
  await page.keyboard.press('Enter');
  await waitActiveText(page, 'scroll-line-80');
  await wait(1200);
  const bottom = await state(page);
  console.log('  bottom state:', {
    scrollTop: bottom.scrollTop,
    scrollHeight: bottom.scrollHeight,
    clientHeight: bottom.clientHeight,
    scrollbar: bottom.scrollbar,
    firstLines: bottom.list.slice(0, 3),
  });
  assert(bottom.rows.includes('scroll-line-80'), '输出已填满屏幕并产生回滚');

  const oneBefore = await state(page);
  await wheel(page, -100, 1);
  const oneAfter = await state(page);
  const oneBeforeNums = oneBefore.list.map((line) => Number(line.replace('scroll-line-', '')));
  const oneAfterNums = oneAfter.list.map((line) => Number(line.replace('scroll-line-', '')));
  console.log('  one notch:', {
    before: oneBeforeNums.slice(0, 4),
    after: oneAfterNums.slice(0, 4),
    beforeCount: oneBeforeNums.length,
    afterCount: oneAfterNums.length,
  });
  assert(
    oneAfterNums.length > 0 && oneAfterNums[0] === oneBeforeNums[0] - 1,
    '一格滚轮在 CMD 回滚中正好滚动一行',
  );
  await wheel(page, 100, 1);
  const oneBack = await state(page);
  assert(oneBack.rows.includes('scroll-line-80'), '一格向下滚回底部');

  await wheel(page, -480);
  const scrolled = await state(page);
  console.log('  after wheel up:', {
    scrollTop: scrolled.scrollTop,
    scrollbar: scrolled.scrollbar,
    firstLines: scrolled.list.slice(0, 3),
    lastLines: scrolled.list.slice(-3),
  });
  console.log(scrolled.rows.slice(0, 400));
  await page.screenshot({ path: resolve(shots, 'scroll-01-wheel-up.png') });
  assert(scrolled.rows !== bottom.rows, '滚轮向上改变了 xterm 视口内容');
  assert(!scrolled.rows.includes('scroll-line-80'), '滚轮向上看到的是更早的历史内容');
  assert(
    scrolled.list.length > 0 && Number(scrolled.list[0].replace('scroll-line-', '')) < 80,
    '滚轮向上显示了更早的行号',
  );

  await wheel(page, 480);
  const back = await state(page);
  console.log('  after wheel down:', {
    scrollTop: back.scrollTop,
    firstLines: back.list.slice(0, 3),
    lastLines: back.list.slice(-3),
  });
  assert(back.rows.includes('scroll-line-80'), '滚轮向下回到最新输出');

  console.log('2. 新建空 CMD 页签，无回滚时滚轮不产生可见副作用');
  await click(page, page.locator('.new-terminal-main'));
  await waitActiveText(page, 'cmd-toolbox>', 30000);
  await wait(600);
  const freshBefore = await state(page);
  await wheel(page, -480, 2);
  const freshAfter = await state(page);
  console.log('  before:', JSON.stringify(freshBefore.rows.slice(-200)));
  console.log('  after :', JSON.stringify(freshAfter.rows.slice(-200)));
  assert(freshBefore.rows === freshAfter.rows, '空 CMD 提示符滚轮不改变屏幕内容');
  await page.screenshot({ path: resolve(shots, 'scroll-02-fresh-cmd.png') });

  console.log('3. PowerShell 提示符滚轮行为');
  await click(page, page.locator('.new-terminal-caret'));
  await page.locator('.popup-item', { hasText: 'PowerShell' }).click();
  await waitActiveText(page, 'PS ', 40000);
  await wait(800);
  await page.locator('.terminal-pane:not(.is-hidden) .xterm-screen').click();
  await page.keyboard.type('echo ps-one');
  await page.keyboard.press('Enter');
  await waitActiveText(page, 'ps-one');
  await wait(500);
  const psBefore = await state(page);
  await wheel(page, -480, 2);
  const psAfter = await state(page);
  console.log('  before:', JSON.stringify(psBefore.rows.slice(-300)));
  console.log('  after :', JSON.stringify(psAfter.rows.slice(-300)));
  console.log('  wheel changed PowerShell screen:', psBefore.rows !== psAfter.rows);
  await page.screenshot({ path: resolve(shots, 'scroll-03-powershell.png') });

  console.log(`\n${passed} 项断言通过`);
} catch (error) {
  if (currentPage) {
    console.log('=== failure snapshot ===');
    await currentPage.screenshot({ path: resolve(shots, 'scroll-failure.png') }).catch(() => {});
    console.log(await currentPage.locator('body').innerText().catch(() => 'no body text'));
  }
  throw error;
} finally {
  if (appPid) restoreZOrder(appPid);
  if (app) await app.close().catch(() => {});
}
