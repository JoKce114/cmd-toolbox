import { _electron as electron } from 'playwright-core';
import { resolve } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { restoreZOrder, sendToBottom } from './zorder.mjs';

const root = resolve(import.meta.dirname, '..');
const dataDir = resolve(root, '.test-data/grok-wheel-lines');
const outDir = resolve(root, '.test-data/grok-wheel-lines-out');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let app;
let appPid;
let page;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function click(page, locator) {
  try {
    await locator.click({ timeout: 6000 });
  } catch (error) {
    const box = await locator.boundingBox();
    if (!box) throw error;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
}

async function waitActiveText(page, needle, timeout = 60000) {
  await page.waitForFunction(
    (text) => document.querySelector('.terminal-pane:not(.is-hidden) .xterm-rows')?.textContent.includes(text),
    needle,
    { timeout },
  );
}

async function rows(page) {
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

try {
  app = await electron.launch({
    executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
    cwd: root,
    args: ['.', `--data-dir=${dataDir}`],
    env,
  });
  page = await app.firstWindow();
  appPid = app.process().pid;
  page.on('pageerror', (error) => console.log('[pageerror]', error.message));
  await page.locator('.app').waitFor();
  await wait(500);
  sendToBottom(appPid);

  await click(page, page.locator('.add-project-btn'));
  await page.locator('#project-path').fill('E:/phpstudy_pro/WWW/web-7.0');
  await page.locator('#project-name').fill('Grok Wheel Lines');
  await click(page, page.getByRole('button', { name: '保存项目', exact: true }));
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await wait(400);
  await click(page, page.getByRole('button', { name: '打开命令提示符', exact: true }));
  await page.locator('.terminal-pane').waitFor();
  await waitActiveText(page, 'web-7.0>', 60000);
  await page.locator('.terminal-pane:not(.is-hidden) .xterm-screen').click();

  await page.keyboard.type('grok');
  await page.keyboard.press('Enter');
  console.log('grok 启动中...');
  await waitActiveText(page, 'Grok', 120000).catch(() => console.log('未检测到 Grok 标题'));
  await wait(4500);
  await page.keyboard.type('/resume');
  await wait(1500);
  await page.keyboard.press('Enter');
  await waitActiveText(page, 'nav', 30000);
  await wait(1500);
  await page.keyboard.press('Enter');
  await wait(6000);
  await page.keyboard.press('Tab');
  await wait(1000);

  const box = await page.locator('.terminal-pane:not(.is-hidden) .xterm-screen').boundingBox();
  const mouseX = box.x + box.width * 0.5;
  const mouseY = box.y + box.height * 0.45;
  await page.mouse.move(mouseX, mouseY);

  const snap = async (label) => {
    const text = await rows(page);
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

  console.log('gestures:', JSON.stringify(results, null, 1));
  const ups = results.filter((item) => item.gesture.startsWith('up'));
  const downs = results.filter((item) => item.gesture.startsWith('down'));
  const ok = ups.every((item) => item.offset === -1 && item.matches >= 3) &&
    downs.every((item) => item.offset === 1 && item.matches >= 3);
  if (!ok) throw new Error('滚轮没有逐行滚动');

  await page.keyboard.press('Tab');
  await wait(600);
  const promptBefore = await snap('prompt-before');
  await wheelOnce(-100);
  const promptAfter = await snap('prompt-after');
  const promptShift = shift(promptBefore, promptAfter);
  console.log('prompt-focused wheel:', promptShift);
  writeFileSync(resolve(outDir, 'gestures.json'), JSON.stringify({ results, promptShift }, null, 2), 'utf8');
  if (promptShift.offset !== -1 || promptShift.matches < 3) throw new Error('提示符聚焦时滚轮没有逐行滚动');

  await page.screenshot({ path: resolve(outDir, 'grok-wheel.png') });
  console.log('PASS 每格滚轮正好一行（滚动区与提示符聚焦）');
} catch (error) {
  if (page) {
    console.log('visible rows:', JSON.stringify(await rows(page).catch(() => 'n/a')));
    await page.screenshot({ path: resolve(outDir, 'failure.png') }).catch(() => {});
  }
  throw error;
} finally {
  if (appPid) restoreZOrder(appPid);
  if (app) await app.close().catch(() => {});
}
