import { _electron as electron } from 'playwright-core';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { restoreZOrder, sendToBottom } from './zorder.mjs';

const root = resolve(import.meta.dirname, '..');
const dataDir = resolve(root, '.test-data/codex-theme');
const workDir = resolve(root, '.test-data/codex-work');
const shots = resolve(root, 'test-shots');
rmSync(dataDir, { recursive: true, force: true });
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
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
    args: [
      '.',
      `--data-dir=${dataDir}`,
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling',
    ],
    env,
  });
  page = await app.firstWindow();
  appPid = app.process().pid;
  await page.locator('.app').waitFor();
  await page.waitForFunction(() => document.visibilityState === 'visible');
  await wait(700);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const output = sendToBottom(appPid);
    if (!output.includes('windows=0')) break;
    await wait(700);
  }
  return page;
}

const rowsText = () =>
  page.evaluate(
    () =>
      document.querySelector('.terminal-pane:not(.is-hidden) .xterm-rows')?.textContent || '',
  );

async function waitForPrompt() {
  await page.locator('.terminal-pane').waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector('.terminal-pane:not(.is-hidden) .xterm-rows')
        ?.textContent.includes('codex-work>'),
    null,
    { timeout: 60000 },
  );
}

async function startSession() {
  await launch();
  await click(page.locator('.add-project-btn'));
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill(workDir.replaceAll('\\', '/'));
  await page.locator('#project-name').fill('Codex Check');
  await click(page.getByRole('button', { name: '保存项目', exact: true }));
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await wait(400);
  await click(page.getByRole('button', { name: '打开命令提示符', exact: true }));
  await waitForPrompt();
}

async function openExistingSession() {
  await page.locator('.group-item').filter({ hasText: 'Codex Check' }).first().click();
  await wait(400);
  await click(page.getByRole('button', { name: '打开命令提示符', exact: true }));
  await waitForPrompt();
}

async function screenshotScreen(label) {
  const shot = await page
    .locator('.terminal-pane:not(.is-hidden) .xterm-screen')
    .screenshot({ path: resolve(shots, `codex-${label}.png`) });
  writeFileSync(resolve(shots, `codex-${label}-screen.png`), shot);
  return shot.toString('base64');
}

const analyze = (base64) =>
  page.evaluate(async (imageBase64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${imageBase64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, image.width, image.height);
    const bandRows = [];
    for (let y = 0; y < height; y += 1) {
      let dark = 0;
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        if (data[index] + data[index + 1] + data[index + 2] < 200) dark += 1;
      }
      if (dark > width * 0.6) bandRows.push(y);
    }
    let brightInBand = 0;
    for (const y of bandRows) {
      for (let x = 25; x < width; x += 1) {
        const index = (y * width + x) * 4;
        if (data[index] + data[index + 1] + data[index + 2] > 420) brightInBand += 1;
      }
    }
    return { width, height, bandRows: bandRows.length, brightInBand };
  }, base64);

async function runCodex(label) {
  await click(page.locator('.terminal-pane:not(.is-hidden) .xterm-screen'));
  await page.keyboard.type('codex');
  await page.keyboard.press('Enter');
  await wait(2500);
  if ((await rowsText()).includes('Do you trust the contents of this directory')) {
    await page.keyboard.press('Enter');
  }
  await page.waitForFunction(
    () =>
      document
        .querySelector('.terminal-pane:not(.is-hidden) .xterm-rows')
        ?.textContent.includes('OpenAI Codex'),
    null,
    { timeout: 90000 },
  );
  await wait(1800);
  const before = await analyze(await screenshotScreen(`${label}-empty`));
  await page.keyboard.type('contrast check MMMMMMMM MMMMMMMM');
  await wait(700);
  const after = await analyze(await screenshotScreen(label));
  console.log(`  ${label} screen`, JSON.stringify({ before, after }));
  return { before, after };
}

try {
  console.log('1. 浅色终端启动 Codex');
  await startSession();
  await click(page.locator('.theme-option[title="浅色终端"]'));
  await wait(300);
  const light = await runCodex('light');
  assert(
    light.before.brightInBand > 100 && light.after.brightInBand > 100,
    '浅色下 Codex 输入区文字清晰可见',
  );

  console.log('2. 深色终端启动 Codex');
  restoreZOrder(appPid);
  await app.close();
  app = null;
  await launch();
  await click(page.locator('.theme-option[title="深色终端"]'));
  await wait(300);
  await openExistingSession();
  const dark = await runCodex('dark');
  assert(
    dark.before.brightInBand > 100 && dark.after.brightInBand > 100,
    '深色下 Codex 输入区文字依旧清晰',
  );

  console.log(`\n全部通过：${passed} 项断言`);
} finally {
  if (app) {
    restoreZOrder(appPid);
    await app.close().catch(() => {});
  }
}
