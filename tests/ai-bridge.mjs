// AI 控制面的端到端测试：带 token 直接打 MCP HTTP 接口，验证
// open_terminal / open_browser / close_pane 真的在渲染进程建出页签，
// 并带上 AI 页签标记；随后在同一页签上验证 terminal_run / job_output /
// terminal_send / terminal_wait 的执行、复用、增量读取与并发拒绝。
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
  assert(names.includes('terminal_interrupt'), '列出 terminal_interrupt');

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

  // ---- 执行命令类工具 ----
  // 后续用例都复用步骤 2 建的 AI 终端。默认 shell 是 cmd，
  // 因此命令全部用 cmd 内建写法，不依赖外部程序。

  console.log('5. terminal_run 复用同项目 AI 终端执行命令');
  const tabsBeforeRun = await page.locator('.tab').count();
  const run = await mcpCall('terminal_run', { project: 'ai-proj', command: 'echo hello-ai' });
  assert(
    run.status === 'done' || run.status === 'idle',
    `命令结束时返回终态（实际 status=${run.status}）`,
  );
  assert(
    typeof run.output === 'string' && run.output.includes('hello-ai'),
    `输出含命令结果（实际：${String(run.output).slice(0, 200)}）`,
  );
  assert(
    typeof run.pane === 'string' && run.pane.startsWith('#'),
    `返回 pane 编号（实际：${JSON.stringify(run.pane)}）`,
  );
  assert(typeof run.jobId === 'string' && run.jobId.length > 0, '返回非空 jobId');
  assert(
    typeof run.cursor === 'number' && run.cursor > 0,
    `返回大于 0 的 cursor（实际：${JSON.stringify(run.cursor)}）`,
  );
  assert(
    run.pane === opened.pane,
    `不传 pane 时复用步骤 2 的 AI 终端（返回 ${run.pane}，期望 ${opened.pane}）`,
  );
  // 「复用」不能只看命令跑通：页签数没有增加才说明没有新建
  const tabsAfterRun = await page.locator('.tab').count();
  assert(
    tabsAfterRun === tabsBeforeRun,
    `复用不新建页签（之前 ${tabsBeforeRun} 个，之后 ${tabsAfterRun} 个）`,
  );
  assert((await tabInfo(run.pane)) !== null, `复用的 AI 终端页签仍在 DOM 中（${run.pane}）`);

  console.log('6. job_output 按 cursor 增量读取');
  const tail = await mcpCall('job_output', { jobId: run.jobId, cursor: run.cursor });
  assert(
    typeof tail.cursor === 'number' && tail.cursor >= run.cursor,
    `cursor 不回退（任务末尾 ${run.cursor}，读回 ${JSON.stringify(tail.cursor)}）`,
  );
  assert(
    typeof tail.output === 'string' && !tail.output.includes('hello-ai'),
    `从任务末尾 cursor 起不重复返回已读输出（实际：${String(tail.output).slice(0, 200)}）`,
  );
  const head = await mcpCall('job_output', { jobId: run.jobId, cursor: 0 });
  assert(head.output.includes('hello-ai'), 'cursor=0 能读到该任务的输出');
  assert(
    head.cursor >= tail.cursor,
    `从头读取的 cursor 覆盖到末尾（${head.cursor} >= ${tail.cursor}）`,
  );

  console.log('7. terminal_run 指定 pane 执行');
  const explicit = await mcpCall('terminal_run', { command: 'echo again-ok', pane: run.pane });
  assert(
    explicit.status === 'done' || explicit.status === 'idle',
    `指定 pane 的命令结束（实际 status=${explicit.status}）`,
  );
  assert(
    explicit.output.includes('again-ok'),
    `指定 pane 拿到输出（实际：${String(explicit.output).slice(0, 200)}）`,
  );
  assert(explicit.pane === run.pane, `返回的 pane 与指定的相同（${explicit.pane}）`);

  console.log('8. 同 pane 并发返回 pane-busy');
  const tabsBeforeLong = await page.locator('.tab').count();
  // 长任务每约 1 秒打一行 tick，quietMs 内持续有输出，占用不会被提前释放。
  // 不要用纯静默的 timeout：它不产生任何输出，1.2 秒后就会被判定 idle 并释放，
  // 测不到并发拒绝。
  const longCommand = 'for /l %i in (1,1,5) do @(ping -n 2 127.0.0.1 >nul & echo tick-%i)';
  const longPromise = mcpCall('terminal_run', {
    command: longCommand,
    pane: run.pane,
    quietMs: 4000,
    timeoutMs: 30000,
  });
  // 断言提前失败时也要吃掉拒绝，避免未处理的 rejection 干扰后续清理
  longPromise.catch(() => {});
  const ticked = await mcpCall('terminal_wait', {
    pane: run.pane,
    pattern: 'tick-1',
    timeoutMs: 10000,
  });
  assert(
    ticked.status === 'matched',
    `长命令确实开始输出，第一条 job 仍在运行（实际 status=${ticked.status}）`,
  );
  const busy = await mcpCall('terminal_run', { command: 'echo busy-probe', pane: run.pane }).then(
    () => 'no-error',
    (error) => String(error.message),
  );
  assert(busy.includes('pane-busy'), `并发命令被拒绝（实际：${busy.slice(0, 200)}）`);
  const longResult = await longPromise;
  assert(
    longResult.status === 'done' || longResult.status === 'idle',
    `长命令结束后释放占用（实际 status=${longResult.status}）`,
  );
  assert(
    longResult.output.includes('tick-5'),
    `长命令完整执行到第 5 轮（实际尾部：${String(longResult.output).slice(-300)}）`,
  );
  assert(
    (await page.locator('.tab').count()) === tabsBeforeLong,
    '并发拒绝没有新建页签',
  );

  console.log('9. terminal_send 向已有终端发按键');
  // terminal_send 与 terminal_run 共用占用表：这里能成功，也证明上一条长任务已释放干净。
  await mcpCall('terminal_send', { pane: run.pane, text: 'echo sent^inel-ok' });
  // ^ 是 cmd 的转义符：命令回显里是 sent^inel-ok，只有真实输出才是 sentinel-ok，
  // 这样匹配到的一定是命令结果，而不是终端对输入行的回显。
  const sent = await mcpCall('terminal_wait', {
    pane: run.pane,
    pattern: 'sentinel-ok',
    timeoutMs: 8000,
  });
  assert(sent.status === 'matched', `等到发送命令的输出（实际 status=${sent.status}）`);

  console.log('10. terminal_wait 超时');
  const waitStart = Date.now();
  const timeoutResult = await mcpCall('terminal_wait', {
    pane: run.pane,
    pattern: 'never-appears-xyz-9f3a',
    timeoutMs: 1000,
  });
  const waitedMs = Date.now() - waitStart;
  assert(
    timeoutResult.status === 'timeout',
    `未命中时返回 timeout（实际 status=${timeoutResult.status}）`,
  );
  assert(waitedMs >= 700, `确实等满了超时时间（实际等了 ${waitedMs}ms）`);

  console.log('11. 显式 project 不存在时返回 no-project，不回退到激活项目');
  // 静默回退会让 AI 以为在项目 A 执行，实际写进项目 B，输出也被归错项目。
  const tabsBeforeMissing = await page.locator('.tab').count();
  const missingTerminal = await mcpCall('open_terminal', { project: 'no-such-project-9f3a' }).then(
    () => 'no-error',
    (error) => String(error.message),
  );
  assert(
    missingTerminal.includes('no-project') &&
      missingTerminal.includes('no-such-project-9f3a'),
    `create-terminal 未命中项目返回 no-project 并说明项目名（实际：${missingTerminal.slice(0, 200)}）`,
  );
  const missingBrowser = await mcpCall('open_browser', {
    project: 'no-such-project-9f3a',
    url: 'about:blank',
  }).then(
    () => 'no-error',
    (error) => String(error.message),
  );
  assert(
    missingBrowser.includes('no-project') &&
      missingBrowser.includes('no-such-project-9f3a'),
    `create-browser 未命中项目返回 no-project 并说明项目名（实际：${missingBrowser.slice(0, 200)}）`,
  );
  assert(
    (await page.locator('.tab').count()) === tabsBeforeMissing,
    '未命中项目时没有偷偷在当前激活项目建页签',
  );

  console.log('12. 持续输出命令可被 terminal_interrupt 中断并复用终端');
  // ping -t 永不安静，quiet 不会触发；3 秒后 terminal_run 只能返回 running。
  const pingPromise = mcpCall('terminal_run', {
    command: 'ping -t 127.0.0.1',
    pane: run.pane,
    quietMs: 1500,
    timeoutMs: 3000,
  });
  const pingResult = await pingPromise;
  assert(
    pingResult.status === 'running',
    `持续输出命令超时返回 running（实际 status=${pingResult.status}）`,
  );
  assert(
    typeof pingResult.hint === 'string' && pingResult.hint.includes('terminal_interrupt'),
    `running 回包提示中断手段（实际：${JSON.stringify(pingResult.hint)}）`,
  );
  // 占用期间 terminal_send 仍然拒绝（任意输入会喂给正在跑的进程）
  const blockedSend = await mcpCall('terminal_send', {
    pane: run.pane,
    text: 'echo should-not-run',
  }).then(
    () => 'no-error',
    (error) => String(error.message),
  );
  assert(
    blockedSend.includes('pane-busy') && blockedSend.includes('terminal_interrupt'),
    `占用期间 terminal_send 返回 pane-busy 并提示 terminal_interrupt（实际：${blockedSend.slice(0, 200)}）`,
  );
  const interrupted = await mcpCall('terminal_interrupt', { pane: run.pane });
  assert(interrupted.ok === true, 'terminal_interrupt 在占用期间仍然成功');
  assert(
    interrupted.jobId === pingResult.jobId,
    `中断回包带上正在跑的 jobId（${interrupted.jobId} / ${pingResult.jobId}）`,
  );
  // Ctrl+C 让 ping 退出，输出安静后旧 job 释放占用
  await waitFor(
    async () => {
      const state = await mcpCall('job_output', {
        jobId: pingResult.jobId,
        cursor: pingResult.cursor,
      });
      return state.status !== 'running';
    },
    '中断后旧任务释放占用',
    15000,
  );
  const afterInterrupt = await mcpCall('terminal_run', {
    command: 'echo after-interrupt-ok',
    pane: run.pane,
  });
  assert(
    afterInterrupt.status === 'done' || afterInterrupt.status === 'idle',
    `中断后终端可再次执行命令（实际 status=${afterInterrupt.status}）`,
  );
  assert(
    afterInterrupt.output.includes('after-interrupt-ok'),
    `中断后新命令正常拿到输出（实际：${String(afterInterrupt.output).slice(0, 200)}）`,
  );
} finally {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}

console.log(`\n全部通过：${passed} 项`);
