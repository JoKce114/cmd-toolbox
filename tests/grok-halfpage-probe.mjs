import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const exe = resolve(root, 'release/CmdToolbox.exe');
const dataDir = resolve(root, '.test-data/grok-halfpage');
const port = 9355;

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

function normalized(text) {
  return screenLines(text).join('\n').trimEnd();
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

  await click(page, page.locator('.add-project-btn'));
  await page.locator('#project-path').fill('E:/phpstudy_pro/WWW/web-7.0');
  await page.locator('#project-name').fill('Grok Half Page');
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

  await page.keyboard.press('Tab');
  await wait(900);
  const bottom = screenLines(await rows(page)).filter((line) => line.trim()).slice(-2).join(' / ');
  console.log('footer:', bottom.slice(0, 200));

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

  async function write(data) {
    await page.evaluate(([id, payload]) => window.api.pty.write(id, payload), [sid, data]);
  }

  async function settle(timeout = 8000) {
    let last = await rows(page);
    let lastChange = Date.now();
    const started = Date.now();
    while (Date.now() - started < timeout) {
      await wait(80);
      const current = await rows(page);
      if (current !== last) {
        last = current;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= 240) {
        return { text: current, elapsed: Date.now() - started };
      }
    }
    return { text: last, elapsed: Date.now() - started };
  }

  async function downOne(label) {
    const a = await rows(page);
    const t0 = Date.now();
    await write('\x04');
    const half = await settle();
    const d = bestShift(a, half.text);
    if (d.offset <= 0) {
      console.log(`${label.padEnd(18)} d=${d.offset}/${d.matches} no-op totalMs=${Date.now() - t0}`);
      return { d: d.offset, ok: true };
    }
    const ups = Math.max(0, d.offset - 1);
    const t1 = Date.now();
    if (ups > 0) await write('\x0b'.repeat(ups));
    const landed = await settle();
    const b = landed.text;
    await write('\x0b');
    const back = await settle();
    const c = back.text;
    console.log(
      `${label.padEnd(18)} d=${String(d.offset).padStart(3)}/${String(d.matches).padStart(2)} ups=${String(ups).padStart(3)} downShift=${bestShift(a, b).offset} backSame=${normalized(c) === normalized(a)} halfMs=${t1 - t0} totalMs=${Date.now() - t0}`,
    );
    if (normalized(c) !== normalized(a)) {
      const la = screenLines(a);
      const lc = screenLines(c);
      for (let i = 0, shown = 0; i < Math.max(la.length, lc.length) && shown < 3; i += 1) {
        if (la[i] !== lc[i]) {
          console.log(`  row ${i}: A=${JSON.stringify((la[i] || '').slice(0, 50))} C=${JSON.stringify((lc[i] || '').slice(0, 50))}`);
          shown += 1;
        }
      }
    }
    return { d: d.offset, ok: normalized(c) === normalized(a) };
  }

  await write('\x1b[6~\x1b[6~');
  await settle();
  await write('\x0b'.repeat(10));
  await settle();
  await downOne('k=10');
  await downOne('k=9');

  await write('\x0b'.repeat(40));
  await settle(12000);
  await downOne('k=49');

  await write('\x0b'.repeat(250));
  await settle(15000);
  await downOne('k=288');

  for (let i = 0; i < 40; i += 1) await write('\x04');
  await settle(15000);
  await downOne('bottom');
} finally {
  if (browser) await browser.close().catch(() => {});
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
