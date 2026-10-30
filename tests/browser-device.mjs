// 浏览器页签：F5 刷新（焦点在地址栏 / 在网页内两条路径）。
import { _electron as electron } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-browser-'));

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

let hits = 0;
const server = createServer((req, res) => {
  hits += 1;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<html><body><h1 id="n">hit ${hits}</h1></body></html>`);
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

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.app').waitFor();
  await page.waitForTimeout(1000);

  await page.locator('.add-project-btn').click();
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill('D:/project-demo/cmd-toolbox');
  await page.locator('#project-name').fill('browser-proj');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await page.waitForTimeout(400);

  await page.locator('.group-main', { hasText: 'browser-proj' }).click();
  await page.waitForTimeout(400);
  await page.locator('.new-terminal-caret').first().click();
  await page.waitForTimeout(300);
  await page.locator('.popup-menu').getByText('浏览器', { exact: true }).first().click();
  await page.waitForTimeout(2000);

  const address = page.locator('.browser-address input');
  await address.fill(pageUrl);
  await address.press('Enter');
  await page.waitForTimeout(1200);

  const loaded = await page.evaluate(async () => {
    const el = document.querySelector('.browser-view');
    return el.executeJavaScript('document.getElementById("n").textContent');
  });
  assert(loaded.startsWith('hit'), `网页已加载，实际 ${loaded}`);
  const hitsAfterLoad = hits;

  console.log('1. 焦点在地址栏按 F5');
  await address.click();
  await address.press('F5');
  await page.waitForTimeout(1200);
  assert(hits > hitsAfterLoad, `地址栏 F5 触发重新请求，${hitsAfterLoad} → ${hits}`);

  console.log('2. 焦点在网页内按 F5（主进程 before-input-event）');
  const before = hits;
  await app.evaluate(async ({ webContents }) => {
    const guest = webContents.getAllWebContents().find((wc) => wc.getType() === 'webview');
    if (!guest) throw new Error('没有找到 webview guest');
    guest.sendInputEvent({ type: 'keyDown', keyCode: 'F5' });
    guest.sendInputEvent({ type: 'keyUp', keyCode: 'F5' });
  });
  await page.waitForTimeout(1500);
  assert(hits > before, `页内 F5 触发重新请求，${before} → ${hits}`);

  console.log('3. Ctrl+R 同样生效');
  const beforeCtrl = hits;
  await app.evaluate(({ webContents }) => {
    const all = webContents.getAllWebContents();
    const guest = all.find((wc) => wc.getType() === 'webview');
    guest.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: ['control'] });
    guest.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: ['control'] });
  });
  await page.waitForTimeout(1500);
  assert(hits > beforeCtrl, `页内 Ctrl+R 触发重新请求，${beforeCtrl} → ${hits}`);

  const metrics = async () =>
    page.evaluate(async () => {
      const el = document.querySelector('.browser-view');
      const raw = await el.executeJavaScript(
        'JSON.stringify({iw: innerWidth, ih: innerHeight, ua: navigator.userAgent})',
      );
      return JSON.parse(raw);
    });

  console.log('4. 切换到 iPhone SE');
  await page.getByRole('button', { name: '切换设备模拟' }).click();
  await page.waitForTimeout(300);
  await page.locator('.popup-menu').getByText('iPhone SE', { exact: true }).click();
  await page.waitForTimeout(1200);
  let m = await metrics();
  assert(m.iw === 375, `iPhone SE 竖屏 innerWidth 为 375，实际 ${m.iw}`);
  assert(m.ih === 667, `iPhone SE 竖屏 innerHeight 为 667，实际 ${m.ih}`);
  assert(m.ua.includes('iPhone'), 'UA 已切换为移动端');
  await page.screenshot({ path: 'test-shots/browser-device-mobile.png' });

  console.log('5. 切换为横屏');
  await page.getByRole('button', { name: /设备模拟：/ }).click();
  await page.waitForTimeout(300);
  await page.locator('.popup-menu').getByText('切换为横屏').click();
  await page.waitForTimeout(1200);
  m = await metrics();
  assert(m.iw === 667, `横屏 innerWidth 为 667，实际 ${m.iw}`);
  assert(m.ih === 375, `横屏 innerHeight 为 375，实际 ${m.ih}`);

  console.log('6. 切回桌面');
  await page.getByRole('button', { name: /设备模拟：/ }).click();
  await page.waitForTimeout(300);
  await page.locator('.popup-menu').getByText('桌面', { exact: true }).click();
  await page.waitForTimeout(1200);
  m = await metrics();
  assert(m.iw > 600, `切回桌面后视口恢复，实际 ${m.iw}`);
  assert(!m.ua.includes('iPhone'), '切回桌面后 UA 已还原');
} finally {
  await app.close();
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n全部通过：${passed} 项`);
