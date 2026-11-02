// 内置浏览器：网页里 target="_blank" / window.open 的链接要在同一个项目里
// 开成新的浏览器页签，而不是被静默丢弃。
import { _electron as electron } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-popup-'));

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error('断言失败：' + message);
  passed += 1;
  console.log('  ok  ' + message);
}

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (req.url === '/popup') {
    res.end('<html><body><h1 id="where">popup page</h1></body></html>');
    return;
  }
  res.end(`<html><body>
    <a id="blank" href="/popup" target="_blank">新窗口</a>
    <button id="js" onclick="window.open('/popup')">window.open</button>
  </body></html>`);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/`;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.CMDTOOLBOX_NO_UPDATE = '1';

const app = await electron.launch({
  executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
  cwd: root,
  args: ['.', `--data-dir=${dataDir}`],
  env,
});

const guests = () =>
  app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((wc) => wc.getType() === 'webview')
      .map((wc) => wc.id),
  );

// 多个浏览器页签时 guest 的顺序不固定，按 URL 后缀找到要操作的那一个
const guestByUrl = (suffix) =>
  app.evaluate(({ webContents }, suffix) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL().endsWith(suffix));
    return guest ? guest.id : null;
  }, suffix);

// 先在 guest 里直接 click。个别环境下脚本点击没有用户手势、会被弹窗拦下，
// 这时再按元素中心补一次真实鼠标事件
const clickInGuest = async (guestId, selector) => {
  const clicked = await app.evaluate(
    async ({ webContents }, { guestId, selector }) => {
      const guest = webContents.fromId(guestId);
      if (!guest) throw new Error('没有找到 webview guest');
      return guest.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)});
           if (!el) return null;
           el.click();
           const r = el.getBoundingClientRect();
           return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
      );
    },
    { guestId, selector },
  );
  return clicked;
};

const mouseClickInGuest = async (guestId, point) => {
  if (!point) return;
  await app.evaluate(
    ({ webContents }, { guestId, point }) => {
      const guest = webContents.fromId(guestId);
      guest.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      guest.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    },
    { guestId, point },
  );
};

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.app').waitFor();
  await page.waitForTimeout(1000);

  await page.locator('.add-project-btn').click();
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill('D:/project-demo/cmd-toolbox');
  await page.locator('#project-name').fill('popup-proj');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await page.waitForTimeout(400);

  await page.locator('.group-main', { hasText: 'popup-proj' }).click();
  await page.waitForTimeout(400);
  await page.locator('.new-terminal-caret').first().click();
  await page.waitForTimeout(300);
  await page.locator('.popup-menu').getByText('浏览器', { exact: true }).first().click();
  await page.waitForTimeout(2000);

  const address = page.locator('.browser-address input');
  await address.fill(pageUrl);
  await address.press('Enter');
  await page.waitForTimeout(1500);

  const tabs = page.locator('.tabs-scroll .tab');
  const windowsBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  assert((await tabs.count()) === 1, '起始只有一个浏览器页签');

  console.log('1. target="_blank" 在新页签打开');
  const rootGuest = await guestByUrl('/');
  assert(Boolean(rootGuest), '找到了发起请求的 guest');
  const before1 = await tabs.count();
  const point = await clickInGuest(rootGuest, '#blank');
  await page.waitForTimeout(1500);
  if ((await tabs.count()) === before1) {
    await mouseClickInGuest(rootGuest, point);
    await page.waitForTimeout(1500);
  }
  const tabCount = await tabs.count();
  assert(tabCount === before1 + 1, `页签数变成 ${before1 + 1}，实际 ${tabCount}`);
  // 多个浏览器页签时每个 pane 都有自己的地址栏，取最后创建的那个
  const activeAddress = await page.locator('.browser-address input').last().inputValue();
  assert(activeAddress.endsWith('/popup'), `新页签地址是链接目标，实际 ${activeAddress}`);
  const content = await page.evaluate(async () => {
    const els = [...document.querySelectorAll('.browser-view')];
    const el = els[els.length - 1];
    return el.executeJavaScript('document.getElementById("where").textContent');
  });
  assert(content === 'popup page', '新页签已加载目标网页');
  assert(
    (await page.locator('.tabs-scroll .tab .tab-project').allInnerTexts()).every(
      (name) => name === 'popup-proj',
    ),
    '新页签留在原项目里',
  );
  assert(
    (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) ===
      windowsBefore,
    '没有多弹出原生窗口',
  );

  console.log('2. window.open() 同样走新页签');
  await page.locator('.tabs-scroll .tab').first().click();
  await page.waitForTimeout(800);
  const before2 = await tabs.count();
  const point2 = await clickInGuest(rootGuest, '#js');
  await page.waitForTimeout(1500);
  if ((await tabs.count()) === before2) {
    await mouseClickInGuest(rootGuest, point2);
    await page.waitForTimeout(1500);
  }
  const tabCount2 = await tabs.count();
  assert(tabCount2 === before2 + 1, `页签数变成 ${before2 + 1}，实际 ${tabCount2}`);
} finally {
  await app.close();
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n全部通过：${passed} 项`);
