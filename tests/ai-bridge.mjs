// AI 控制面的端到端测试：带 token 直接打 MCP HTTP 接口，验证
// open_terminal / open_browser / close_pane 真的在渲染进程建出页签，
// 并带上 AI 页签标记。
//
// 本文件是后续 AI 工具的测试骨架：startApp / mcpCall 可直接复用，
// 新用例按编号往下追加即可。
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-ai-data-'));
const repo = mkdtempSync(join(tmpdir(), 'cmdtb-ai-repo-'));
const shotDir = resolve(root, 'test-shots');
mkdirSync(shotDir, { recursive: true });

execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
writeFileSync(join(repo, 'readme.txt'), 'hello\n');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// 测试环境不发真实的 GitHub 更新请求
env.CMDTOOLBOX_NO_UPDATE = '1';

const app = await electron.launch({
  executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
  cwd: root,
  args: ['.', `--data-dir=${dataDir}`],
  env,
});
const page = await app.firstWindow();
page.on('pageerror', (error) => console.log('  [pageerror]', error.message));
await page.waitForLoadState('domcontentloaded');
await page.locator('.app').waitFor();
await page.waitForFunction(() => !document.querySelector('.boot-screen'));
await page.waitForTimeout(1200);

// 若窗口被其他程序遮挡，Chromium 不会投递合成的鼠标事件；确保窗口置于最前
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0];
  win?.show();
  win?.focus();
  win?.moveTop();
});

// MCP token 由主进程写入 userData；直接读文件拿到带 token 的地址
const token = readFileSync(join(dataDir, 'mcp-token.txt'), 'utf8').trim();
const base = 'http://127.0.0.1:17382';

async function click(locator) {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      await locator.click({ timeout: 3000, force: true });
      return;
    } catch (error) {
      const box = await locator.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return;
      }
      if (Date.now() > deadline) throw error;
      await page.waitForTimeout(300);
    }
  }
}

async function waitFor(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${message}`);
    await page.waitForTimeout(250);
  }
}

async function mcpCall(name, args = {}) {
  const response = await fetch(`${base}/mcp?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const payload = await response.json();
  const text = payload.result?.content?.[0]?.text ?? '';
  if (payload.result?.isError) throw new Error(text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function addProject(path, name) {
  const modal = page.locator('.modal-card');
  const deadline = Date.now() + 20000;
  while ((await modal.count()) === 0) {
    if (Date.now() > deadline) throw new Error('等待超时：添加项目弹窗未出现');
    await click(page.locator('.add-project-btn'));
    await page.waitForTimeout(600);
  }
  await page.locator('#project-path').fill(path);
  await page.locator('#project-name').fill(name);
  await click(page.getByRole('button', { name: '保存项目', exact: true }));
  await modal.waitFor({ state: 'detached', timeout: 15000 });
  // 项目行出现说明渲染进程的 groups 已就绪，MCP 才能按名字命中
  await page.locator('.group-item').filter({ hasText: name }).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
}

try {
  await addProject(repo, 'ai-proj');

  console.log('1. tools/list 包含新工具');
  const listResponse = await fetch(`${base}/mcp?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const listPayload = await listResponse.json();
  const names = listPayload.result.tools.map((tool) => tool.name);
  assert(names.includes('open_terminal'), '列出 open_terminal');
  assert(names.includes('open_browser'), '列出 open_browser');
  assert(names.includes('close_pane'), '列出 close_pane');

  console.log('2. open_terminal 建出终端页签');
  const beforeTabs = await page.locator('.tab').count();
  const opened = await mcpCall('open_terminal', { project: 'ai-proj' });
  assert(typeof opened.pane === 'string' && opened.pane.startsWith('#'), '返回 pane 编号');
  // scopedRef 形如 #N 或「项目名#N」；新建页签可能尚未同步到 panes，项目名会省略
  assert(
    typeof opened.scopedRef === 'string' && /#\d+$/.test(opened.scopedRef),
    '返回 scopedRef',
  );
  assert(typeof opened.tabId === 'string' && opened.tabId.length > 0, '返回 tabId');
  assert(typeof opened.sessionId === 'string' && opened.sessionId.length > 0, '返回 sessionId');
  await waitFor(
    async () => (await page.locator('.tab').count()) === beforeTabs + 1,
    '页签数 +1',
  );
  assert((await page.locator('.tab').count()) === beforeTabs + 1, '页签数 +1');
  assert((await page.locator('.tab.is-ai').count()) >= 1, '页签带 AI 标记');
  assert((await page.locator('.tab.is-ai .tab-ai-icon').count()) >= 1, '页签带 AI 图标');
  const aiTabText = await page.locator('.tab.is-ai').first().innerText();
  // 终端页签的 descriptor 来自 defaultTabTitle(shell.label)，默认 shell 是
  // 命令提示符，所以标题里是「命令提示符」而不是「AI 终端」。
  assert(aiTabText.includes('命令提示符'), '页签标题为默认终端「命令提示符」');
  console.log(`  info  页签实际文本：${JSON.stringify(aiTabText)}`);

  console.log('3. open_browser 建出浏览器页签');
  const beforeBrowser = await page.locator('.tab').count();
  const browser = await mcpCall('open_browser', { project: 'ai-proj', url: 'about:blank' });
  assert(typeof browser.pane === 'string' && browser.pane.startsWith('#'), '返回浏览器 pane');
  assert(
    typeof browser.scopedRef === 'string' && /#\d+$/.test(browser.scopedRef),
    '返回浏览器 scopedRef',
  );
  await waitFor(
    async () => (await page.locator('.tab').count()) === beforeBrowser + 1,
    '浏览器页签数 +1',
  );
  assert(
    (await page.locator('.tab').count()) === beforeBrowser + 1,
    '浏览器页签数 +1',
  );
  assert((await page.locator('.tab.is-ai').count()) >= 2, '浏览器页签同样带 AI 标记');

  console.log('4. close_pane 关闭页签');
  // findPane 读的是主进程里由 panes:sync 同步过来的列表，新页签可能还没到；
  // 轮询 list_panes 直到能查到，既等于等待同步，也顺带验证 pane 可被解析。
  await waitFor(
    async () => {
      const listed = await mcpCall('list_panes');
      return (listed.panes || []).some((pane) => `#${pane.paneNo}` === browser.pane);
    },
    '浏览器页签同步到主进程',
  );
  const afterOpen = await page.locator('.tab').count();
  await mcpCall('close_pane', { pane: browser.scopedRef });
  await waitFor(
    async () => (await page.locator('.tab').count()) === afterOpen - 1,
    '页签数 -1',
  );
  assert((await page.locator('.tab').count()) === afterOpen - 1, '页签数 -1');
} finally {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}

console.log(`\n全部通过：${passed} 项`);
