// 探针：确认移动端模拟的可行实现路径。
//
// 结论（2026-10-30 实测）：
// - webContents.enableDeviceEmulation 对 <webview> 的 guest **不可用**：
//   它按可用区域缩放内容，375×667 会变成 innerWidth=981、innerHeight=1744，
//   视口完全不对。不要再用它。
// - 正确做法是纯前端：把 <webview> 元素本身设成设备尺寸，
//   CSS 视口即随之变为 375×667，媒体查询正确生效。
// - UA 用 webview 元素自带的 setUserAgent()，不需要主进程参与。
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-probe-'));
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

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

  // 建项目 → 从「新建终端」菜单开浏览器页签
  await page.locator('.add-project-btn').click();
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill('D:/project-demo/cmd-toolbox');
  await page.locator('#project-name').fill('probe-proj');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await page.waitForTimeout(400);

  await page.locator('.group-main', { hasText: 'probe-proj' }).click();
  await page.waitForTimeout(400);

  await page.locator('.new-terminal-caret').first().click();
  await page.waitForTimeout(300);
  await page.locator('.popup-menu').getByText('浏览器', { exact: true }).first().click();
  await page.waitForTimeout(2500);

  await page.locator('.browser-view').first().waitFor({ timeout: 15000 });

  const before = await page.evaluate(() => {
    const el = document.querySelector('.browser-view');
    window.__probeView = el;
    return el.executeJavaScript('JSON.stringify({iw: innerWidth, ua: navigator.userAgent})');
  });
  const desktop = JSON.parse(before);
  console.log('桌面模式 =', before);
  assert(desktop.iw > 600, `桌面模式视口为大宽度，实际 ${desktop.iw}`);

  const mobile = await page.evaluate(async (ua) => {
    const el = window.__probeView;
    el.style.width = '375px';
    el.style.height = '667px';
    el.style.flex = '0 0 auto';
    el.setUserAgent(ua);
    await new Promise((done) => setTimeout(done, 800));
    return el.executeJavaScript('JSON.stringify({iw: innerWidth, ih: innerHeight, ua: navigator.userAgent})');
  }, MOBILE_UA);
  const mobileMetrics = JSON.parse(mobile);
  console.log('移动模式 =', mobile);
  assert(mobileMetrics.iw === 375, `移动模式 innerWidth 为 375，实际 ${mobileMetrics.iw}`);
  assert(mobileMetrics.ih === 667, `移动模式 innerHeight 为 667，实际 ${mobileMetrics.ih}`);
  assert(mobileMetrics.ua.includes('iPhone'), '移动模式 UA 已切换为 iPhone');

  const back = await page.evaluate(async () => {
    const el = window.__probeView;
    el.style.width = '';
    el.style.height = '';
    el.style.flex = '';
    el.setUserAgent('');
    await new Promise((done) => setTimeout(done, 800));
    return el.executeJavaScript('JSON.stringify({iw: innerWidth, ua: navigator.userAgent})');
  });
  const backMetrics = JSON.parse(back);
  console.log('恢复桌面 =', back);
  assert(backMetrics.iw > 600, `退出模拟后视口恢复，实际 ${backMetrics.iw}`);
  assert(!backMetrics.ua.includes('iPhone'), '退出模拟后 UA 已还原');
} finally {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n全部通过：${passed} 项`);
