import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'upd-'));
const shots = resolve(root, 'test-shots');
mkdirSync(shots, { recursive: true });

let passed = 0;
const ok = (condition, message) => {
  if (!condition) throw new Error('断言失败：' + message);
  passed += 1;
  console.log('  ok  ' + message);
};
const waitFor = async (fn, message, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error('等待超时：' + message);
    await new Promise((r) => setTimeout(r, 250));
  }
};

// 假 GitHub Release 接口：应用侧走的是和线上完全一样的解析与公告判定。
// 真实接口 /releases 返回数组，已按发布时间倒序。
const release = {
  tag_name: 'v9.9.0',
  html_url: 'https://github.com/JoKce114/cmd-toolbox/releases/tag/v9.9.0',
  body: '### 测试更新\n- 第一项改动\n- 第二项改动',
};
let hits = 0;
const server = createServer((req, res) => {
  hits += 1;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify([release]));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const apiUrl = `http://127.0.0.1:${server.address().port}/releases`;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CMDTOOLBOX_NO_UPDATE;
env.CMDTOOLBOX_UPDATE_API = apiUrl;

const app = await electron.launch({
  executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
  cwd: root,
  args: ['.', `--data-dir=${dataDir}`],
  env,
});

const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');

// 全新数据目录里 seen 为空会走「首次启用不打扰」分支，先按当前版本预置
const currentVersion = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
await page.evaluate((version) => {
  localStorage.setItem('cmd-toolbox.seen-update', version);
}, currentVersion);

// 把 30 分钟的后台轮询压到 1.5 秒，否则测试里观察不到
await page.addInitScript(() => {
  const raw = window.setInterval.bind(window);
  window.setInterval = (fn, delay, ...rest) =>
    raw(fn, typeof delay === 'number' && delay > 60000 ? 1500 : delay, ...rest);
});
await page.reload();
await page.waitForSelector('.app', { timeout: 30000 });

const dot = page.locator('.titlebar-update-dot');
// 设置面板本身也是 .modal-card，公告弹窗用独有的 .announcement-actions 区分
const modal = page.locator('.modal-card').filter({ has: page.locator('.announcement-actions') });
const settingsBtn = page.locator('.titlebar-settings');

console.log('1. 启动检查发现新版本');
await dot.waitFor({ state: 'attached', timeout: 20000 });
ok(true, '设置按钮旁出现红色圆点');
ok(
  (await settingsBtn.getAttribute('title')).includes('有新版本'),
  '设置按钮 title 提示有新版本',
);
await modal.waitFor({ timeout: 20000 });
ok((await modal.innerText()).includes('发现新版本'), '启动时弹出了更新公告');
ok((await modal.innerText()).includes('v9.9.0'), '公告标题带版本号');
ok(
  (await modal.locator('.announcement-release-version').allInnerTexts()).includes('v9.9.0'),
  '公告正文按版本分块列出',
);
ok(
  (await modal.locator('.announcement-release-link').count()) === 1,
  '每个版本带 GitHub 链接',
);
ok(
  (await modal.locator('.announcement-body').innerText()).includes('第一项改动'),
  '显示该版本自己的更新说明',
);
ok(
  (await modal
    .locator('.announcement-body')
    .evaluate((el) => getComputedStyle(el).overflowY)) === 'auto',
  '版本列表区域可滚动',
);
await page.screenshot({ path: join(shots, 'update-announce.png') });

console.log('2. 关闭公告后红点保留');
await page.getByRole('button', { name: '稍后', exact: true }).click();
await modal.waitFor({ state: 'detached', timeout: 10000 });
ok((await dot.count()) === 1, '关掉公告后红点仍然在');

console.log('3. 后台轮询只刷新红点，不弹公告');
const hitsBefore = hits;
await page.waitForTimeout(4000);
ok((await modal.count()) === 0, '后台检查没有弹窗');
ok((await dot.count()) === 1, '后台检查后红点仍在');
ok(hits >= hitsBefore, '后台检查确实发起了请求');

console.log('4. 设置面板显示新版本与手动更新入口');
await settingsBtn.click();
await page.waitForSelector('.settings-body', { timeout: 15000 });
const newRow = page.locator('.settings-item').filter({ hasText: '发现新版本' });
await newRow.first().waitFor({ timeout: 10000 });
ok((await newRow.first().innerText()).includes('v9.9.0'), '关于分组显示发现新版本');
ok(
  (await page.getByRole('button', { name: /立即更新|重试|前往下载/ }).count()) > 0,
  '有手动更新按钮',
);
await page.screenshot({ path: join(shots, 'update-settings.png') });

console.log('5. 手动检查不弹公告');
const hitsBeforeManual = hits;
await page.getByRole('button', { name: '检查更新', exact: true }).click();
await page.waitForTimeout(1500);
ok((await modal.count()) === 0, '手动检查只在设置里显示结果');
ok(hits >= hitsBeforeManual, '手动检查走的是同一个接口');

console.log('6. 关于页签在设置最左');
const tabs = await page.locator('.settings-tab').allInnerTexts();
ok(tabs[0].includes('关于'), '关于页签排在第一位');
ok(
  (await page
    .locator('.settings-body')
    .evaluate((el) => getComputedStyle(el).overflowY)) === 'auto',
  '设置内容超出时可滚动',
);

console.log(`\n全部通过：${passed} 项`);
await app.close();
server.close();
