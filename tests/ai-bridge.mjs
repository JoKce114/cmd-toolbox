// AI 控制面的端到端测试：带 token 直接打 MCP HTTP 接口，验证
// open_terminal / open_browser / close_pane 真的在渲染进程建出页签，
// 并带上 AI 页签标记。
//
// 本文件是后续 AI 工具的测试骨架：startApp / mcpCall 可直接复用，
// 新用例按编号往下追加即可。
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-ai-data-'));
const repo = mkdtempSync(join(tmpdir(), 'cmdtb-ai-repo-'));

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

// 只接受「真正的成功」：非 2xx、JSON-RPC error、空 content 都必须抛错，
// 否则错误会被 JSON.parse('') 静默吞成空字符串，伪装成成功返回空值。
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
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`MCP ${name} 返回 HTTP ${response.status}：${body.slice(0, 200)}`);
  }
  const payload = await response.json();
  if (payload.error) {
    throw new Error(
      `MCP ${name} 返回 JSON-RPC 错误：${payload.error.message || JSON.stringify(payload.error)}`,
    );
  }
  const text = payload.result?.content?.[0]?.text;
  if (payload.result?.isError) {
    throw new Error(`MCP ${name} 执行失败：${text || '（无错误信息）'}`);
  }
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(
      `MCP ${name} 返回了空内容：${JSON.stringify(payload).slice(0, 200)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// 按 pane 编号（#N）精确找到一个页签，避免用 first() 被既有页签满足
async function tabInfo(pane) {
  return page.evaluate((value) => {
    const tab = [...document.querySelectorAll('.tab')].find(
      (node) => node.querySelector('.tab-pane')?.textContent?.trim() === value,
    );
    if (!tab) return null;
    return {
      isAi: tab.classList.contains('is-ai'),
      hasIcon: Boolean(tab.querySelector('.tab-ai-icon')),
      title: tab.querySelector('.tab-func')?.textContent?.trim() || '',
      text: tab.innerText,
    };
  }, pane);
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
  // 记录建之前的 AI 页签数，后面只认「增量」里新增的那一个
  const aiTabsBefore = await page.locator('.tab.is-ai').count();
  const aiTerminalTitlesBefore = (
    await page.locator('.tab.is-ai .tab-func').allInnerTexts()
  ).filter((title) => title.trim() === 'AI 终端').length;
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
  await waitFor(
    async () => (await page.locator('.tab.is-ai').count()) === aiTabsBefore + 1,
    'AI 页签数 +1',
  );
  const aiTerminalTitlesAfter = (
    await page.locator('.tab.is-ai .tab-func').allInnerTexts()
  ).filter((title) => title.trim() === 'AI 终端').length;
  assert(
    aiTerminalTitlesAfter === aiTerminalTitlesBefore + 1,
    '新增且仅新增一个标题为「AI 终端」的页签',
  );
  // 用返回的 pane 编号精确定位新页签，避免 first() 命中既有 AI 页签
  const terminalTab = await tabInfo(opened.pane);
  assert(terminalTab !== null, `按 pane ${opened.pane} 找到新页签`);
  assert(terminalTab?.isAi === true, '新增页签带 .tab.is-ai');
  assert(terminalTab?.hasIcon === true, '新增页签带 .tab-ai-icon');
  assert(terminalTab?.title === 'AI 终端', '新增页签标题固定为「AI 终端」');
  console.log(`  info  新页签实际文本：${JSON.stringify(terminalTab?.text)}`);

  console.log('3. open_browser 建出浏览器页签');
  const beforeBrowser = await page.locator('.tab').count();
  const aiBrowserBefore = await page.locator('.tab.is-ai').count();
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
  await waitFor(
    async () => (await page.locator('.tab.is-ai').count()) === aiBrowserBefore + 1,
    '浏览器 AI 页签数 +1',
  );
  const browserTab = await tabInfo(browser.pane);
  assert(browserTab !== null, `按 pane ${browser.pane} 找到浏览器页签`);
  assert(browserTab?.isAi === true, '浏览器页签带 .tab.is-ai');
  assert(browserTab?.hasIcon === true, '浏览器页签带 .tab-ai-icon');
  console.log(`  info  浏览器页签实际文本：${JSON.stringify(browserTab?.text)}`);

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
  assert((await tabInfo(browser.pane)) === null, '被关闭的浏览器页签已从 DOM 消失');
} finally {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}

console.log(`\n全部通过：${passed} 项`);
