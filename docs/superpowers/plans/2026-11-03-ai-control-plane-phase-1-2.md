# AI 控制面阶段 1+2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 通过现有 MCP 端点新建终端/浏览器页签，并在终端里执行命令、等到输出安静后取回清理过的结果与退出码。

**Architecture:** 主进程新增 `ai-bridge.js` 提供「主进程请求渲染进程并等回值」的双向通道；`pane-api.js` 退化为传输层，工具实现拆到 `ai-tools/panes.js` 与 `ai-tools/jobs.js`；终端执行复用 `pty-host.js` 的既有会话与 `getLastOutput`。

**Tech Stack:** Electron 主进程（CommonJS）、Node `http`、React + TypeScript（渲染进程）、Playwright 端到端测试、Node 内置断言脚本。

## Global Constraints

- 只面向 Windows；不新增监听端口，沿用 `127.0.0.1:17382` 与现有 token。
- 所有新增文件用 CommonJS（`require` / `module.exports`），与 `desktop/` 现有风格一致。
- 提交信息只写改动本身和原因，**不加任何 AI 署名**（不要 `Co-Authored-By`、不要 `Generated with`）。
- 渲染进程改动后用 `npx tsc --noEmit && npx vite build` 验证，**不要用 `npm run build`**（会改脏被跟踪的 `build/coninject.exe`）。
- 不要改 `package.json` 的版本号，不新增运行时依赖。
- UI 测试必须独占：先 `powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"`，再确认 17382 空闲。
- `terminal_run` 的命令**不做拦截**（已确认的设计决定），但 cwd 固定为项目根，路径不得越出项目。
- 同一 pane 上不允许并发 `terminal_run`，后到的返回 `pane-busy`。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `desktop/ai-bridge.js` | 主进程 → 渲染进程的请求/应答通道 | 创建 |
| `desktop/ai-tools/ansi.js` | pty 输出的 ANSI / `\r` 清理 | 创建 |
| `desktop/ai-tools/panes.js` | 开/关/列/读窗格 | 创建 |
| `desktop/ai-tools/jobs.js` | `terminal_run` / `job_output` / `terminal_send` / `terminal_wait` | 创建 |
| `desktop/pane-api.js` | 退化为传输层，汇总各模块工具 | 修改 |
| `desktop/main.js` | 启动桥接、接上渲染进程回包 | 修改 |
| `desktop/preload.js` | 暴露 `onBridgeRequest` / `bridgeReply` | 修改 |
| `desktop/session.js` | 放行 `aiOwned` 字段 | 修改 |
| `src/types.ts` | `Tab` 加 `aiOwned?: boolean` | 修改 |
| `src/App.tsx` | 订阅桥接请求，按 op 建页签 | 修改 |
| `src/components/TabStrip.tsx` | AI 页签图标与底色 | 修改 |
| `src/styles.css` | `.tab.is-ai` 样式 | 修改 |
| `src/global.d.ts` | 桥接 API 类型 | 修改 |
| `tests/ai-ansi.mjs` | 输出清理与安静判定的离线测试 | 创建 |
| `tests/ai-bridge.mjs` | 端到端 MCP 调用 | 创建 |

---

### Task 1: 输出清理函数

**Files:**
- Create: `desktop/ai-tools/ansi.js`
- Test: `tests/ai-ansi.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `cleanOutput(raw: string): string` —— 剥 CSI/OSC、处理 `\r` 覆盖、裁剪尾部空行
  - `stripAnsi(raw: string): string` —— 只剥控制序列，不处理 `\r`

- [ ] **Step 1: 写失败的测试**

创建 `tests/ai-ansi.mjs`：

```js
const { cleanOutput, stripAnsi } = require('../desktop/ai-tools/ansi.js');

let passed = 0;
const assert = (cond, msg) => {
  if (!cond) throw new Error(`断言失败：${msg}`);
  passed += 1;
  console.log('  ok  ' + msg);
};

console.log('1. 剥离 CSI 颜色序列');
assert(stripAnsi('\x1b[32mhello\x1b[0m') === 'hello', '颜色被剥掉');
assert(stripAnsi('\x1b[1;31mred\x1b[0m') === 'red', '组合样式被剥掉');

console.log('2. 剥离 OSC 序列（终端标题）');
assert(stripAnsi('\x1b]0;title\x07text') === 'text', 'OSC 被剥掉');

console.log('3. 回车覆盖只保留最后一次');
assert(cleanOutput('10%\r50%\r100%\n') === '100%', '同一行被覆盖成最后结果');

console.log('4. 多行里的回车覆盖');
assert(cleanOutput('a\n10%\r99%\nb\n') === 'a\n99%\nb', '只覆盖所在行');

console.log('5. 尾部空行被裁剪');
assert(cleanOutput('hello\n\n\n') === 'hello', '尾部空行被去掉');
assert(cleanOutput('hello   \n') === 'hello', '行尾空白被去掉');

console.log('6. 连续空行折叠为一行');
assert(cleanOutput('a\n\n\n\nb\n') === 'a\n\nb', '连续空行折叠');

console.log('7. 空输入');
assert(cleanOutput('') === '', '空字符串原样返回');

console.log('8. 退格删除前一个字符');
assert(cleanOutput('abc\x08d\n') === 'abd', '退格生效');

console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node tests/ai-ansi.mjs
```

Expected: FAIL —— `Cannot find module '../desktop/ai-tools/ansi.js'`。

- [ ] **Step 3: 实现**

创建 `desktop/ai-tools/ansi.js`：

```js
// pty 输出里混着 CSI/OSC 控制序列与回车重绘（进度条会反复覆盖同一行）。
// AI 拿到的必须是清理后的文本，否则只能读到一堆转义码。
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OTHER_ESCAPES = /\x1b[@-_]/g;

function stripAnsi(raw) {
  return String(raw || '')
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(OTHER_ESCAPES, '');
}

// 回车表示回到行首重写，退格表示删除前一个字符。逐行处理，
// 不做跨行的光标移动解析——那需要完整终端模拟，收益远小于成本。
function applyLineEdits(line) {
  let out = '';
  for (const char of line) {
    if (char === '\r') {
      out = '';
      continue;
    }
    if (char === '\b') {
      out = out.slice(0, -1);
      continue;
    }
    out += char;
  }
  return out;
}

function cleanOutput(raw) {
  const text = stripAnsi(raw);
  if (!text) return '';
  const lines = text.split('\n').map((line) => applyLineEdits(line).replace(/\s+$/, ''));
  const collapsed = [];
  for (const line of lines) {
    if (line === '' && collapsed.length && collapsed[collapsed.length - 1] === '') continue;
    collapsed.push(line);
  }
  while (collapsed.length && collapsed[collapsed.length - 1] === '') collapsed.pop();
  return collapsed.join('\n');
}

module.exports = { cleanOutput, stripAnsi };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node tests/ai-ansi.mjs
```

Expected: `全部通过：9 项`。

- [ ] **Step 5: 提交**

```bash
git add desktop/ai-tools/ansi.js tests/ai-ansi.mjs
git commit -m "feat(ai): 终端输出清理——剥离控制序列与回车覆盖"
```

---

### Task 2: 主进程到渲染进程的请求应答通道

**Files:**
- Create: `desktop/ai-bridge.js`
- Modify: `desktop/main.js`（`registerIpc()` 内加 `bridge:reply` 处理，`createWindow` 后注入 sender）
- Modify: `desktop/preload.js`（暴露 `onBridgeRequest` / `bridgeReply`）
- Test: 无独立测试文件（纯时序逻辑，由 Task 6 的端到端覆盖）

**Interfaces:**
- Consumes: 无
- Produces:
  - `configure({ send, timeoutMs })` —— `send(op)` 由 `main.js` 注入为 `webContents.send('bridge:request', payload)`
  - `request(op: string, payload: object, timeoutMs?: number): Promise<any>`
  - `settle(requestId: string, ok: boolean, payload: any): boolean`
  - `pendingCount(): number`（测试用）

- [ ] **Step 1: 实现 `desktop/ai-bridge.js`**

```js
const crypto = require('crypto');

const DEFAULT_TIMEOUT = 15000;

let send = null;
let defaultTimeoutMs = DEFAULT_TIMEOUT;
const pending = new Map();

function configure(options = {}) {
  if (typeof options.send === 'function') send = options.send;
  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    defaultTimeoutMs = Math.min(60000, Math.floor(options.timeoutMs));
  }
}

function request(op, payload = {}, timeoutMs) {
  // 窗口没起来时立即失败，不排队——排队会让 AI 误以为操作被接受了
  if (typeof send !== 'function') {
    const error = new Error('窗口未就绪，无法执行该操作');
    error.code = 'ui-unavailable';
    return Promise.reject(error);
  }
  const requestId = crypto.randomUUID();
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : defaultTimeoutMs;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      const error = new Error('渲染进程没有在超时内响应');
      error.code = 'ui-unavailable';
      reject(error);
    }, limit);
    pending.set(requestId, { resolve, reject, timer });
    try {
      send({ requestId, op, payload });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(error);
    }
  });
}

function settle(requestId, ok, payload) {
  const entry = pending.get(String(requestId || ''));
  if (!entry) return false;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  if (ok) {
    entry.resolve(payload);
  } else {
    const error = new Error((payload && payload.message) || '渲染进程执行失败');
    error.code = (payload && payload.code) || 'ui-unavailable';
    entry.reject(error);
  }
  return true;
}

function pendingCount() {
  return pending.size;
}

module.exports = { configure, request, settle, pendingCount };
```

- [ ] **Step 2: 在 `main.js` 注册回包并接线**

在 `desktop/main.js` 顶部 `require` 区追加：

```js
const aiBridge = require('./ai-bridge');
```

在 `registerIpc()` 函数内、`ipcMain.on('panes:sync', ...)` 之前插入：

```js
  ipcMain.on('bridge:reply', (_event, requestId, ok, payload) => {
    aiBridge.settle(requestId, Boolean(ok), payload);
  });
```

在 `createWindow()` 返回之后（窗口已创建处）添加：

```js
    aiBridge.configure({
      send: (payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('bridge:request', payload);
        }
      },
    });
```

- [ ] **Step 3: 在 `preload.js` 暴露接口**

在 `contextBridge.exposeInMainWorld('api', {` 内追加（放在 `panes` 之前）：

```js
  bridge: {
    reply: (requestId, ok, payload) =>
      ipcRenderer.send('bridge:reply', requestId, ok, payload),
    onRequest: (handler) => subscribe('bridge:request', handler),
  },
```

- [ ] **Step 4: 类型声明**

在 `src/global.d.ts` 的 `api` 类型里、`panes` 定义之前追加：

```ts
    bridge: {
      reply: (
        requestId: string,
        ok: boolean,
        payload?: { message?: string; code?: string; [key: string]: unknown },
      ) => void;
      onRequest: (
        handler: (message: {
          requestId: string;
          op: string;
          payload: Record<string, unknown>;
        }) => void,
      ) => () => void;
    };
```

- [ ] **Step 5: 类型检查**

```bash
npx tsc --noEmit
```

Expected: 无输出，退出码 0。

- [ ] **Step 6: 提交**

```bash
git add desktop/ai-bridge.js desktop/main.js desktop/preload.js src/global.d.ts
git commit -m "feat(ai): 主进程到渲染进程的请求应答通道"
```

---

### Task 3: 页签的 AI 标记

**Files:**
- Modify: `src/types.ts`（`Tab` 加字段）
- Modify: `desktop/session.js`（`normalizeTab` 放行）
- Modify: `src/components/TabStrip.tsx`（图标与类名）
- Modify: `src/styles.css`（`.tab.is-ai`）

**Interfaces:**
- Consumes: 无
- Produces: `Tab.aiOwned?: boolean`；页签根元素带 `is-ai` 类名

- [ ] **Step 1: 加类型字段**

在 `src/types.ts` 的 `Tab` 类型里，`exited: boolean;` 之前插入：

```ts
  aiOwned?: boolean;
```

- [ ] **Step 2: 会话恢复放行该字段**

在 `desktop/session.js` 的 `normalizeTab` 返回对象里，`custom: Boolean(value.custom),` 之后插入：

```js
    aiOwned: Boolean(value.aiOwned),
```

- [ ] **Step 3: 页签渲染图标与类名**

在 `src/components/TabStrip.tsx` 顶部图标 import 里加入 `Sparkles`：

```tsx
import { ChevronDown, FileCode2, Plus, Sparkles, X } from 'lucide-react';
```

把页签根元素的 `className` 表达式里 `tab.exited && 'exited',` 之后插入：

```tsx
          tab.aiOwned && 'is-ai',
```

在 `<span className="tab-title">` 的开标签之后、`{showLamp ? (` 之前插入：

```tsx
          {tab.aiOwned ? <Sparkles size={11} className="tab-ai-icon" /> : null}
```

同时把页签的 `title` 属性改为带上 AI 说明：

```tsx
        title={`#${tab.paneNo} · ${group.name} · ${tab.descriptor}\n${tab.cwd}${
          tab.aiOwned ? '\n由 AI 打开' : ''
        }\n双击重命名用途`}
```

- [ ] **Step 4: 加样式**

在 `src/styles.css` 里 `.tab.exited` 规则之后追加：

```css
.tab.is-ai {
  background-image: linear-gradient(180deg, rgba(139, 92, 246, 0.1), rgba(139, 92, 246, 0.04));
}

.tab.is-ai.active {
  background-image: linear-gradient(180deg, rgba(139, 92, 246, 0.16), rgba(139, 92, 246, 0.06));
}

.tab-ai-icon {
  flex: 0 0 auto;
  margin-right: 3px;
  color: #7c3aed;
}
```

- [ ] **Step 5: 类型检查与构建**

```bash
npx tsc --noEmit && npx vite build
```

Expected: 无报错。

- [ ] **Step 6: 提交**

```bash
git add src/types.ts desktop/session.js src/components/TabStrip.tsx src/styles.css
git commit -m "feat(ai): AI 打开的页签带标记与淡紫底色"
```

---

### Task 4: 渲染进程响应桥接请求

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `window.api.bridge.onRequest`、`window.api.bridge.reply`（Task 2）；`Tab.aiOwned`（Task 3）；现有 `createTerminal`、`createBrowser`、`closeTabs`
- Produces: 桥接 `op` 的实现：`create-terminal`、`create-browser`、`close-pane`

- [ ] **Step 1: 给 `createTerminal` 加 AI 标记参数**

把 `src/App.tsx` 中 `createTerminal` 的签名从

```tsx
    async (group: Group, shellId?: string): Promise<Tab | null> => {
```

改为

```tsx
    async (
      group: Group,
      shellId?: string,
      options: { aiOwned?: boolean; focus?: boolean } = {},
    ): Promise<Tab | null> => {
```

在 `const tab: Tab = {` 的对象里、`exited: false,` 之前加入：

```tsx
          aiOwned: Boolean(options.aiOwned),
```

把创建后聚焦的那段（`applyTabs({ ... }); setActiveGroupKey(group.key);` 之后到 `return tab;` 之前）整体包进条件：

```tsx
        setActiveGroupKey(group.key);
        if (options.focus !== false) {
          const onRight =
            (focusSideByGroupRef.current[group.key] || 'left') === 'right' &&
            (rightIdsByGroupRef.current[group.key] || []).length > 0;
          if (onRight) {
            setRightIdsByGroup((previous) => ({
              ...previous,
              [group.key]: [...(previous[group.key] || []), tab.id],
            }));
            setRightActiveByGroup((previous) => ({ ...previous, [group.key]: tab.id }));
          } else {
            setActiveTabByGroup((previous) => ({ ...previous, [group.key]: tab.id }));
          }
        }
        return tab;
```

- [ ] **Step 2: 给 `createBrowser` 加 AI 标记参数**

把签名从

```tsx
    (group: Group, url = 'about:blank') => {
```

改为

```tsx
    (
      group: Group,
      url = 'about:blank',
      options: { aiOwned?: boolean; focus?: boolean } = {},
    ) => {
```

在 `const tab: Tab = {` 的对象里、`exited: false,` 之前加入：

```tsx
        aiOwned: Boolean(options.aiOwned),
```

同样把聚焦段包进 `if (options.focus !== false) { ... }`。`createBrowser` 目前返回 `void`，
改为在末尾 `return tab;`，返回类型标注为 `Tab | void`。

- [ ] **Step 3: 注册桥接订阅**

在 `src/App.tsx` 里紧接现有的 `browser.onOpenUrl` effect（约 1740 行）之后插入：

```tsx
  // AI 通过 MCP 请求建页签：真正建页签的代码在渲染进程，主进程只能通过桥接委托
  const createTerminalRef = useRef(createTerminal);
  createTerminalRef.current = createTerminal;
  const closeTabsRef = useRef(closeTabs);
  closeTabsRef.current = closeTabs;
  // activeGroupKeyRef 已在 App.tsx 第 256 行定义，直接复用，不要重复声明

  useEffect(() => {
    const bridge = window.api?.bridge;
    if (!bridge) return;
    return bridge.onRequest(async ({ requestId, op, payload }) => {
      const reply = (ok: boolean, body?: unknown) =>
        bridge.reply(requestId, ok, (body ?? {}) as Record<string, unknown>);
      try {
        if (op === 'create-terminal') {
          // project 可能是项目名，也可能为空（用当前激活项目）
          const wanted = String(payload.groupKey || '').trim();
          const group =
            (wanted &&
              (groupsByKeyRef.current.get(wanted) ||
                [...groupsByKeyRef.current.values()].find(
                  (item) => item.name && item.name.toLowerCase() === wanted.toLowerCase(),
                ))) ||
            groupsByKeyRef.current.get(activeGroupKeyRef.current) ||
            null;
          if (!group) {
            reply(false, { code: 'no-project', message: '找不到该项目' });
            return;
          }
          const tab = await createTerminalRef.current(
            group,
            typeof payload.shellId === 'string' ? payload.shellId : undefined,
            { aiOwned: true, focus: false },
          );
          if (!tab) {
            reply(false, { code: 'ui-unavailable', message: '终端创建失败' });
            return;
          }
          reply(true, {
            tabId: tab.id,
            paneNo: tab.paneNo,
            pane: `#${tab.paneNo}`,
            sessionId: tab.sessionId,
            groupKey: group.key,
          });
          return;
        }
        if (op === 'create-browser') {
          const wanted = String(payload.groupKey || '').trim();
          const group =
            (wanted &&
              (groupsByKeyRef.current.get(wanted) ||
                [...groupsByKeyRef.current.values()].find(
                  (item) => item.name && item.name.toLowerCase() === wanted.toLowerCase(),
                ))) ||
            groupsByKeyRef.current.get(activeGroupKeyRef.current) ||
            null;
          if (!group) {
            reply(false, { code: 'no-project', message: '找不到该项目' });
            return;
          }
          const tab = createBrowserRef.current(
            group,
            typeof payload.url === 'string' && payload.url ? payload.url : 'about:blank',
            { aiOwned: true, focus: false },
          ) as Tab | undefined;
          if (!tab) {
            reply(false, { code: 'ui-unavailable', message: '浏览器创建失败' });
            return;
          }
          reply(true, {
            tabId: tab.id,
            paneNo: tab.paneNo,
            pane: `#${tab.paneNo}`,
            groupKey: group.key,
          });
          return;
        }
        if (op === 'close-pane') {
          const groupKey = String(payload.groupKey || '');
          const tabId = String(payload.tabId || '');
          const closed = closeTabsRef.current(groupKey, [tabId]);
          reply(closed, closed ? { closed: true } : { code: 'pane-not-found', message: '页签已不存在' });
          return;
        }
        reply(false, { code: 'bad-request', message: `未知操作：${op}` });
      } catch (error) {
        reply(false, { code: 'ui-unavailable', message: toErrorMessage(error) });
      }
    });
  }, []);
```

- [ ] **Step 4: 类型检查与构建**

```bash
npx tsc --noEmit && npx vite build
```

Expected: 无报错。

- [ ] **Step 5: 提交**

```bash
git add src/App.tsx
git commit -m "feat(ai): 渲染进程响应桥接请求并创建 AI 页签"
```

---

### Task 5: 页签工具（open_terminal / open_browser / list_panes 扩展 / close_pane）

**Files:**
- Create: `desktop/ai-tools/panes.js`
- Modify: `desktop/pane-api.js`（工具表合并、`dispatch` 分派）

**Interfaces:**
- Consumes: `aiBridge.request`（Task 2）；`pane-api` 的 `findPane`、`panes` 数组
- Produces:
  - `TOOLS: Array<{ name, description, inputSchema }>`
  - `call(name: string, args: object, ctx: { findPane, panes }): Promise<unknown>`

- [ ] **Step 1: 实现 `desktop/ai-tools/panes.js`**

```js
const aiBridge = require('../ai-bridge');

function projectGroupKey(args) {
  const value = args && typeof args.project === 'string' ? args.project.trim() : '';
  return value;
}

const TOOLS = [
  {
    name: 'open_terminal',
    description:
      '在 Cmd Toolbox 里打开一个新的终端页签（用户可见，带 AI 标记）。返回 pane（如 #3）与 sessionId，后续执行命令时把 pane 传回去。不传 project 时使用当前激活的项目。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目名或 groupKey，省略则用当前激活项目' },
        shellId: {
          type: 'string',
          description: '终端类型：cmd / powershell / gitbash / claude 等，省略用项目默认',
        },
      },
    },
  },
  {
    name: 'open_browser',
    description:
      '在 Cmd Toolbox 里打开一个新的浏览器页签（用户可见，带 AI 标记）。返回 pane，之后可用 get_pane_content 读取页面、browser_click 点击。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目名或 groupKey，省略则用当前激活项目' },
        url: { type: 'string', description: '要打开的地址，必须是 http/https，省略为 about:blank' },
      },
    },
  },
  {
    name: 'close_pane',
    description: '关闭 Cmd Toolbox 里的某个页签。',
    inputSchema: {
      type: 'object',
      properties: { pane: { type: 'string', description: '页签编号，如 #3' } },
      required: ['pane'],
    },
  },
];

async function call(name, args, ctx) {
  if (name === 'open_terminal') {
    const groupKey = projectGroupKey(args);
    return aiBridge.request('create-terminal', {
      groupKey,
      shellId: typeof args.shellId === 'string' ? args.shellId : '',
    });
  }
  if (name === 'open_browser') {
    const groupKey = projectGroupKey(args);
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    if (url && !/^https?:\/\//i.test(url)) {
      const error = new Error('只支持 http 或 https 地址');
      error.code = 'bad-request';
      throw error;
    }
    return aiBridge.request('create-browser', { groupKey, url });
  }
  if (name === 'close_pane') {
    const pane = ctx.findPane(args.pane);
    if (!pane) {
      const error = new Error('找不到这个窗格，请先用 list_panes 看编号');
      error.code = 'pane-not-found';
      throw error;
    }
    return aiBridge.request('close-pane', { groupKey: pane.groupKey, tabId: pane.id });
  }
  throw new Error(`未知工具：${name}`);
}

module.exports = { TOOLS, call };
```

- [ ] **Step 2: 让 `pane-api.js` 合并工具表并分派**

在 `desktop/pane-api.js` 顶部 require 区加入：

```js
const paneTools = require('./ai-tools/panes');
```

把 `const MCP_TOOLS = [` 改名为 `const BUILTIN_TOOLS = [`，并在它之后（`callMcpTool` 之前）加入：

```js
const MCP_TOOLS = [...BUILTIN_TOOLS, ...paneTools.TOOLS];
```

在 `callMcpTool` 函数的第一行之前插入：

```js
  if (paneTools.TOOLS.some((tool) => tool.name === name)) {
    return paneTools.call(name, args || {}, { findPane, panes, groupKeyOf: () => '' });
  }
```

同时在 `dispatch` 的 `/panes` 返回项里补上 `id` 与 `groupKey`，让 `close_pane` 能定位：

把 `panes: panes.map((pane) => ({` 的对象里 `paneNo: pane.paneNo,` 之后加入：

```js
        id: pane.id,
        groupKey: pane.groupKey || '',
```

- [ ] **Step 3: 手工冒烟（不需要 GUI 也先确认模块能加载）**

```bash
node -e "require('./desktop/ai-tools/panes.js'); console.log('ok')"
```

Expected: 输出 `ok`。

- [ ] **Step 4: 提交**

```bash
git add desktop/ai-tools/panes.js desktop/pane-api.js
git commit -m "feat(ai): open_terminal / open_browser / close_pane 工具"
```

---

### Task 6: 端到端验证建页签

**Files:**
- Create: `tests/ai-bridge.mjs`

**Interfaces:**
- Consumes: Task 1–5 的全部产出
- Produces: 后续任务复用的测试骨架（`startApp`、`mcpCall`）

- [ ] **Step 1: 写端到端测试的骨架与前两个用例**

创建 `tests/ai-bridge.mjs`：

```js
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

// MCP token 由主进程写入 userData；直接读文件拿到带 token 的地址
const tokenFile = join(dataDir, 'mcp-token.txt');
const token = (await import('node:fs')).readFileSync(tokenFile, 'utf8').trim();
const base = 'http://127.0.0.1:17382';

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
  await page.locator('.add-project-btn').click();
  await modal.waitFor({ timeout: 15000 });
  await page.locator('#project-path').fill(path);
  await page.locator('#project-name').fill(name);
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await modal.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(800);
}

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
assert(typeof opened.sessionId === 'string' && opened.sessionId.length > 0, '返回 sessionId');
await page.waitForTimeout(800);
assert((await page.locator('.tab').count()) === beforeTabs + 1, '页签数 +1');
assert(
  (await page.locator('.tab.is-ai').count()) >= 1,
  '页签带 AI 标记',
);
const aiTabText = await page.locator('.tab.is-ai').first().innerText();
assert(aiTabText.includes('AI 终端'), '页签标题为「AI 终端」');

console.log('3. open_browser 建出浏览器页签');
const browser = await mcpCall('open_browser', { project: 'ai-proj', url: 'about:blank' });
assert(typeof browser.pane === 'string', '返回浏览器 pane');

console.log('4. close_pane 关闭页签');
const afterOpen = await page.locator('.tab').count();
await mcpCall('close_pane', { pane: browser.pane });
await page.waitForTimeout(800);
assert((await page.locator('.tab').count()) === afterOpen - 1, '页签数 -1');

await app.close();

console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 2: 清理环境并运行**

```bash
powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"
sleep 3
netstat -ano | grep LISTENING | grep 17382 || echo PORT_FREE
npx tsc --noEmit && npx vite build
node tests/ai-bridge.mjs
```

Expected: 全部断言通过；末尾 `全部通过：N 项`。

- [ ] **Step 3: 提交**

```bash
git add tests/ai-bridge.mjs
git commit -m "test(ai): 端到端验证 MCP 建页签与关闭"
```

---

### Task 7: 任务句柄与 terminal_run

**Files:**
- Create: `desktop/ai-tools/jobs.js`
- Modify: `desktop/pane-api.js`（合并 jobs 工具、传入 pty 能力）
- Modify: `desktop/main.js`（把 pty 能力注入 pane-api）

**Interfaces:**
- Consumes: `cleanOutput`（Task 1）；`aiBridge.request`（Task 2）；`ptyHost.writeSession` / `getLastOutput` / `isOpen`；`aiBridge` 的 pane 信息
- Produces:
  - `configure({ writeSession, getLastOutput, isOpen, subscribeData, subscribeExit, findPane, panes })`
  - `TOOLS`（`terminal_run` / `job_output`）
  - `call(name, args)`

- [ ] **Step 1: 实现 `desktop/ai-tools/jobs.js` 的 `terminal_run` 与 `job_output`**

创建 `desktop/ai-tools/jobs.js`：

```js
const crypto = require('crypto');
const { cleanOutput } = require('./ansi');
const aiBridge = require('../ai-bridge');

const DEFAULT_QUIET_MS = 1200;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 600000;

let writeSession = () => {};
let getLastOutput = () => '';
let isOpen = () => false;
let findPane = () => null;
let listPanes = () => [];
let subscribeData = () => () => {};
let subscribeExit = () => () => {};

const jobs = new Map();
const activeBySession = new Map();

function configure(options = {}) {
  if (typeof options.writeSession === 'function') writeSession = options.writeSession;
  if (typeof options.getLastOutput === 'function') getLastOutput = options.getLastOutput;
  if (typeof options.isOpen === 'function') isOpen = options.isOpen;
  if (typeof options.findPane === 'function') findPane = options.findPane;
  if (typeof options.panes === 'function') listPanes = options.panes;
  if (typeof options.subscribeData === 'function') subscribeData = options.subscribeData;
  if (typeof options.subscribeExit === 'function') subscribeExit = options.subscribeExit;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clampTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_TIMEOUT_MS;
  if (number > MAX_TIMEOUT_MS) throw fail('bad-request', 'timeoutMs 不能超过 10 分钟');
  return Math.floor(number);
}

function resolvePane(ref) {
  if (!ref) return null;
  const pane = findPane(ref);
  if (!pane || pane.kind !== 'terminal') {
    throw fail('pane-not-found', '这不是一个终端窗格，请先用 list_panes 查看');
  }
  return pane;
}

function readWindow(sessionId, cursor) {
  const raw = getLastOutput(sessionId) || '';
  // 缓冲区只保留最近 32K 字符，cursor 超出时就从头给
  const start = Math.min(Math.max(0, cursor), raw.length);
  return { raw, start };
}

function finish(job, status, exitCode) {
  const entry = jobs.get(job.id);
  if (!entry || entry.settled) return;
  entry.settled = true;
  activeBySession.delete(entry.sessionId);
  const raw = getLastOutput(entry.sessionId) || '';
  entry.result = {
    status,
    exitCode: typeof exitCode === 'number' ? exitCode : null,
    output: cleanOutput(raw.slice(entry.baseOffset)),
    pane: `#${entry.paneNo}`,
    jobId: entry.id,
    cursor: raw.length,
  };
  entry.resolve(entry.result);
}

async function terminalRun(args = {}) {
  const quietMs = Number(args.quietMs) > 0 ? Math.floor(Number(args.quietMs)) : DEFAULT_QUIET_MS;
  const timeoutMs = clampTimeout(args.timeoutMs);
  const command = String(args.command || '').trim();
  if (!command) throw fail('bad-request', 'command 不能为空');

  let pane = resolvePane(args.pane);
  if (!pane) {
    // 复用 AI 终端：同项目、AI 创建、空闲、无正在跑的任务
    const reuse = listPanes().find(
      (item) =>
        item.kind === 'terminal' &&
        item.aiOwned &&
        item.sessionId &&
        !item.exited &&
        !activeBySession.has(item.sessionId),
    );
    if (reuse) {
      pane = reuse;
    } else {
      const created = await aiBridge.request('create-terminal', { groupKey: '' });
      await new Promise((resolve) => setTimeout(resolve, 400));
      pane = findPane(created.pane);
      if (!pane) throw fail('ui-unavailable', '终端创建后无法定位');
    }
  }

  const sessionId = pane.sessionId;
  if (!sessionId || !isOpen(sessionId)) {
    throw fail('pane-not-found', '该终端已退出，请重新 open_terminal');
  }
  if (activeBySession.has(sessionId)) {
    throw fail('pane-busy', `该终端还有任务在跑（jobId ${activeBySession.get(sessionId)}）`);
  }

  const baseOffset = (getLastOutput(sessionId) || '').length;
  const id = crypto.randomUUID();
  activeBySession.set(sessionId, id);

  return new Promise((resolve, reject) => {
    const entry = {
      id,
      sessionId,
      paneNo: pane.paneNo,
      baseOffset,
      settled: false,
      resolve,
      result: null,
    };
    jobs.set(id, entry);

    let quietTimer = null;
    let timeoutTimer = null;
    const offData = subscribeData((dataSessionId) => {
      if (dataSessionId !== sessionId) return;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(entry, 'idle'), quietMs);
    });
    const offExit = subscribeExit((exitSessionId, code) => {
      if (exitSessionId !== sessionId) return;
      finish(entry, 'done', typeof code === 'number' ? code : 0);
    });

    entry.cleanup = () => {
      if (quietTimer) clearTimeout(quietTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      offData();
      offExit();
    };

    timeoutTimer = setTimeout(() => finish(entry, 'running'), timeoutMs);
    quietTimer = setTimeout(() => finish(entry, 'idle'), quietMs);

    try {
      writeSession(sessionId, `${command}\r`);
    } catch (error) {
      entry.settled = true;
      activeBySession.delete(sessionId);
      entry.cleanup();
      reject(fail('ui-unavailable', error.message || String(error)));
    }
  });
}

function jobOutput(args = {}) {
  const entry = jobs.get(String(args.jobId || ''));
  if (!entry) throw fail('pane-not-found', '找不到这个 jobId，请重新执行命令');
  const cursor = Math.max(0, Math.floor(Number(args.cursor) || 0));
  const raw = getLastOutput(entry.sessionId) || '';
  const start = Math.min(cursor, raw.length);
  return {
    status: entry.settled ? entry.result.status : 'running',
    output: cleanOutput(raw.slice(start)),
    cursor: raw.length,
    jobId: entry.id,
    pane: `#${entry.paneNo}`,
  };
}

const TOOLS = [
  {
    name: 'terminal_run',
    description:
      '在终端里执行一条命令并等待结果。等到进程退出、或输出连续 quietMs 无变化、或超时后返回。返回 status（done/idle/running）、exitCode、output、pane、jobId、cursor。不传 pane 时自动复用 AI 终端页签。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        pane: { type: 'string', description: '目标终端，如 #3；省略则复用 AI 终端' },
        quietMs: { type: 'number', description: '输出安静多久算结束，默认 1200' },
        timeoutMs: { type: 'number', description: '总超时，默认 60000，上限 600000' },
      },
      required: ['command'],
    },
  },
  {
    name: 'job_output',
    description: '读取某个任务自 cursor 以来的新增输出。长任务轮询用，避免重复拿全量。',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        cursor: { type: 'number', description: '上次返回的 cursor，省略为 0' },
      },
      required: ['jobId'],
    },
  },
];

async function call(name, args) {
  if (name === 'terminal_run') return terminalRun(args || {});
  if (name === 'job_output') return jobOutput(args || {});
  throw new Error(`未知工具：${name}`);
}

module.exports = { configure, TOOLS, call };
```

- [ ] **Step 2: 接入 `pane-api.js`**

在 `desktop/pane-api.js` 顶部加入：

```js
const jobTools = require('./ai-tools/jobs');
```

在 `start(options)` 里、`if (typeof options.openUrlInNewTab === 'function') {` 之前插入：

```js
  if (typeof options.jobs === 'function') options.jobs(jobTools);
```

把 `const MCP_TOOLS = [...BUILTIN_TOOLS, ...paneTools.TOOLS];` 改为：

```js
const MCP_TOOLS = [...BUILTIN_TOOLS, ...paneTools.TOOLS, ...jobTools.TOOLS];
```

在 `callMcpTool` 里 `paneTools` 分支之后插入：

```js
  if (jobTools.TOOLS.some((tool) => tool.name === name)) {
    return jobTools.call(name, args || {});
  }
```

- [ ] **Step 3: 在 `main.js` 注入 pty 能力**

在 `desktop/main.js` 的 `paneApi.start({` 调用处，`getTerminalOutput:` 之后插入：

```js
      jobs: (jobTools) => {
        jobTools.configure({
          writeSession: (sessionId, data) => ptyHost.writeSession(sessionId, data),
          getLastOutput: (sessionId) => ptyHost.getLastOutput(sessionId),
          isOpen: (sessionId) => ptyHost.isOpen(sessionId),
          findPane: (ref) => paneApi.findPaneForTool(ref),
          panes: () => paneApi.listPanesForTool(),
          subscribeData: (handler) => {
            const unsubscribe = ptyHost.subscribeAllData?.(handler);
            return typeof unsubscribe === 'function' ? unsubscribe : () => {};
          },
          subscribeExit: (handler) => {
            const unsubscribe = ptyHost.subscribeAllExit?.(handler);
            return typeof unsubscribe === 'function' ? unsubscribe : () => {};
          },
        });
      },
```

- [ ] **Step 4: 在 `pane-api.js` 暴露两个查询函数**

在 `desktop/pane-api.js` 的 `module.exports` 之前加入：

```js
function findPaneForTool(ref) {
  try {
    return findPane(ref);
  } catch {
    return null;
  }
}

function listPanesForTool() {
  return panes;
}
```

并在 `module.exports` 里追加：

```js
  findPaneForTool,
  listPanesForTool,
```

- [ ] **Step 5: 在 `pty-host.js` 增加全局订阅**

在 `desktop/pty-host.js` 里，`closeAll()` 之后、`isOpen` 之前插入：

```js
// AI 的 terminal_run 需要监听所有会话的输出与退出，又不该复用渲染进程的订阅
const globalDataHandlers = new Set();
const globalExitHandlers = new Set();

function subscribeAllData(handler) {
  if (typeof handler !== 'function') return () => {};
  globalDataHandlers.add(handler);
  return () => globalDataHandlers.delete(handler);
}

function subscribeAllExit(handler) {
  if (typeof handler !== 'function') return () => {};
  globalExitHandlers.add(handler);
  return () => globalExitHandlers.delete(handler);
}

function emitGlobalData(id, data) {
  for (const handler of globalDataHandlers) {
    try {
      handler(id, data);
    } catch {
      // 单个订阅者失败不影响其它订阅者
    }
  }
}

function emitGlobalExit(id, code) {
  for (const handler of globalExitHandlers) {
    try {
      handler(id, code);
    } catch {
      // 同上
    }
  }
}
```

在 `spawnSession` 的 `onData` 里，`send('pty:data', id, data);` 之后加入：

```js
    emitGlobalData(id, data);
```

在 `onExit` 里，`send('pty:exit', id, code, signal);` 之后加入：

```js
    emitGlobalExit(id, code);
```

在 `module.exports` 里追加：

```js
  subscribeAllData,
  subscribeAllExit,
```

- [ ] **Step 6: 冒烟加载**

```bash
node -e "require('./desktop/ai-tools/jobs.js'); require('./desktop/pty-host.js'); console.log('ok')"
```

Expected: 输出 `ok`。

- [ ] **Step 7: 提交**

```bash
git add desktop/ai-tools/jobs.js desktop/pane-api.js desktop/main.js desktop/pty-host.js
git commit -m "feat(ai): terminal_run 与 job_output，含 AI 终端复用"
```

---

### Task 8: 驱动已有终端（terminal_send / terminal_wait）

**Files:**
- Modify: `desktop/ai-tools/jobs.js`

**Interfaces:**
- Consumes: Task 7 的模块状态
- Produces: `terminal_send`、`terminal_wait` 两个工具加入 `TOOLS`

- [ ] **Step 1: 追加两个工具实现**

在 `desktop/ai-tools/jobs.js` 的 `jobOutput` 函数之后插入：

```js
function terminalSend(args = {}) {
  const pane = resolvePane(args.pane);
  if (!pane) throw fail('pane-not-found', '请用 list_panes 查看终端编号');
  const text = String(args.text ?? '');
  const submit = args.submit !== false;
  if (!pane.sessionId || !isOpen(pane.sessionId)) {
    throw fail('pane-not-found', '该终端已退出');
  }
  writeSession(pane.sessionId, submit ? `${text}\r` : text);
  return { ok: true, pane: `#${pane.paneNo}`, submitted: submit };
}

function terminalWait(args = {}) {
  const pane = resolvePane(args.pane);
  if (!pane) throw fail('pane-not-found', '请用 list_panes 查看终端编号');
  const pattern = String(args.pattern || '');
  if (!pattern) throw fail('bad-request', 'pattern 不能为空');
  let regex;
  try {
    regex = new RegExp(pattern);
  } catch {
    throw fail('bad-request', 'pattern 不是合法的正则');
  }
  const timeoutMs = clampTimeout(args.timeoutMs || 30000);
  const sessionId = pane.sessionId;

  return new Promise((resolve) => {
    const matches = () => cleanOutput(getLastOutput(sessionId) || '');
    const hit = regex.exec(matches());
    if (hit) {
      resolve({ status: 'matched', match: hit[0], output: matches(), pane: `#${pane.paneNo}` });
      return;
    }
    let timer = null;
    const offData = subscribeData((id) => {
      if (id !== sessionId) return;
      const text = matches();
      const found = regex.exec(text);
      if (!found) return;
      cleanup();
      resolve({ status: 'matched', match: found[0], output: text, pane: `#${pane.paneNo}` });
    });
    const finish = (status) => {
      cleanup();
      resolve({ status, output: matches(), pane: `#${pane.paneNo}` });
    };
    timer = setTimeout(() => finish('timeout'), timeoutMs);
    function cleanup() {
      if (timer) clearTimeout(timer);
      offData();
    }
  });
}
```

- [ ] **Step 2: 加入工具表与分派**

在 `TOOLS` 数组末尾追加两项：

```js
  {
    name: 'terminal_send',
    description:
      '向已有终端发送按键。submit 默认 true（补回车）；交互式 CLI 逐键输入时传 false。',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string' },
        text: { type: 'string' },
        submit: { type: 'boolean' },
      },
      required: ['pane', 'text'],
    },
  },
  {
    name: 'terminal_wait',
    description:
      '等待终端输出匹配某个正则。用于等服务启动就绪、等交互式 CLI 打出提示。返回 status（matched/timeout）与匹配片段。',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string' },
        pattern: { type: 'string', description: '正则字符串' },
        timeoutMs: { type: 'number', description: '默认 30000，上限 600000' },
      },
      required: ['pane', 'pattern'],
    },
  },
```

把 `call` 函数改为：

```js
async function call(name, args) {
  if (name === 'terminal_run') return terminalRun(args || {});
  if (name === 'job_output') return jobOutput(args || {});
  if (name === 'terminal_send') return terminalSend(args || {});
  if (name === 'terminal_wait') return terminalWait(args || {});
  throw new Error(`未知工具：${name}`);
}
```

- [ ] **Step 3: 冒烟加载**

```bash
node -e "require('./desktop/ai-tools/jobs.js'); console.log('ok')"
```

Expected: 输出 `ok`。

- [ ] **Step 4: 提交**

```bash
git add desktop/ai-tools/jobs.js
git commit -m "feat(ai): terminal_send 与 terminal_wait 驱动已有终端"
```

---

### Task 9: 执行命令的端到端测试

**Files:**
- Modify: `tests/ai-bridge.mjs`

**Interfaces:**
- Consumes: Task 7、8 的工具
- Produces: 无

- [ ] **Step 1: 在关闭应用之前插入执行用例**

在 `tests/ai-bridge.mjs` 的 `console.log('4. close_pane 关闭页签');` 段落之后、`await app.close();` 之前插入：

```js
console.log('5. terminal_run 执行命令并拿到输出');
const run = await mcpCall('terminal_run', { command: 'echo hello-ai' });
assert(run.status === 'done' || run.status === 'idle', '命令结束有状态');
assert(run.output.includes('hello-ai'), '输出含命令结果');
assert(typeof run.pane === 'string' && run.pane.startsWith('#'), '返回 pane');
assert(typeof run.jobId === 'string' && run.jobId.length > 0, '返回 jobId');

console.log('6. terminal_run 指定 pane 执行');
const second = await mcpCall('terminal_run', { command: 'echo again', pane: run.pane });
assert(second.output.includes('again'), '指定 pane 也能执行');

console.log('7. job_output 增量读取');
const incremental = await mcpCall('job_output', { jobId: run.jobId, cursor: 0 });
assert(typeof incremental.cursor === 'number', '返回 cursor');
assert(incremental.output.length >= 0, '可读取输出');

console.log('8. 同 pane 并发返回 pane-busy');
const long = mcpCall('terminal_run', { command: 'ping -n 4 127.0.0.1', pane: run.pane, quietMs: 3000 });
const busy = await mcpCall('terminal_run', { command: 'echo x', pane: run.pane }).then(
  () => 'no-error',
  (error) => String(error.message),
);
assert(busy.includes('pane-busy') || busy.includes('任务在跑'), '并发被拒绝');
await long.catch(() => {});

console.log('9. terminal_send 向已有终端发按键');
await mcpCall('terminal_send', { pane: run.pane, text: 'echo sent' });
const sent = await mcpCall('terminal_wait', {
  pane: run.pane,
  pattern: 'sent',
  timeoutMs: 8000,
});
assert(sent.status === 'matched', '等待到输出');

console.log('10. terminal_wait 超时');
const timeoutResult = await mcpCall('terminal_wait', {
  pane: run.pane,
  pattern: 'never-appears-xyz',
  timeoutMs: 1000,
});
assert(timeoutResult.status === 'timeout', '超时返回 timeout');
```

- [ ] **Step 2: 清理环境并运行**

```bash
powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"
sleep 3
netstat -ano | grep LISTENING | grep 17382 || echo PORT_FREE
node tests/ai-bridge.mjs
```

Expected: 全部断言通过。

- [ ] **Step 3: 提交**

```bash
git add tests/ai-bridge.mjs
git commit -m "test(ai): 端到端验证执行命令、增量读取与并发拒绝"
```

---

### Task 10: 离线测试任务判定逻辑

**Files:**
- Create: `tests/ai-jobs.mjs`

**Interfaces:**
- Consumes: `desktop/ai-tools/jobs.js` 的 `configure` 与 `call`
- Produces: 无

- [ ] **Step 1: 写离线测试**

创建 `tests/ai-jobs.mjs`：

```js
const jobs = require('../desktop/ai-tools/jobs.js');

let passed = 0;
const assert = (cond, msg) => {
  if (!cond) throw new Error(`断言失败：${msg}`);
  passed += 1;
  console.log('  ok  ' + msg);
};

const dataHandlers = new Set();
const exitHandlers = new Set();
let buffer = '';
let written = [];
const fakePane = { id: 'tab-1', paneNo: 3, kind: 'terminal', sessionId: 'session-1', aiOwned: true };

jobs.configure({
  writeSession: (_id, data) => {
    written.push(data);
    buffer += data;
    for (const handler of dataHandlers) handler('session-1', data);
  },
  getLastOutput: () => buffer,
  isOpen: () => true,
  findPane: (ref) => (ref === '#3' || ref === 'tab-1' ? fakePane : null),
  panes: () => [fakePane],
  subscribeData: (handler) => {
    dataHandlers.add(handler);
    return () => dataHandlers.delete(handler);
  },
  subscribeExit: (handler) => {
    exitHandlers.add(handler);
    return () => exitHandlers.delete(handler);
  },
});

console.log('1. 命令被写入 pty');
const runPromise = jobs.call('terminal_run', { command: 'echo hi', pane: '#3', quietMs: 50 });
const result = await runPromise;
assert(written.includes('echo hi\r'), '命令带回车写入');
assert(result.status === 'idle', '无退出时安静即返回 idle');
assert(typeof result.jobId === 'string', '返回 jobId');

console.log('2. 进程退出返回 done 与退出码');
buffer = '';
const exitPromise = jobs.call('terminal_run', { command: 'ls', pane: '#3', quietMs: 5000 });
for (const handler of exitHandlers) handler('session-1', 0);
const done = await exitPromise;
assert(done.status === 'done', '退出返回 done');
assert(done.exitCode === 0, '带上退出码');

console.log('3. 空命令被拒绝');
let rejected = false;
try {
  await jobs.call('terminal_run', { command: '   ', pane: '#3' });
} catch (error) {
  rejected = error.code === 'bad-request';
}
assert(rejected, '空命令返回 bad-request');

console.log('4. 超时上限');
let tooLong = false;
try {
  await jobs.call('terminal_run', { command: 'x', pane: '#3', timeoutMs: 700000 });
} catch (error) {
  tooLong = error.code === 'bad-request';
}
assert(tooLong, '超时超过 10 分钟被拒绝');

console.log('5. job_output 增量');
const first = jobs.call('job_output', { jobId: result.jobId, cursor: 0 });
assert(typeof first.cursor === 'number', '返回 cursor');
const second = jobs.call('job_output', { jobId: result.jobId, cursor: first.cursor });
assert(second.output === '', 'cursor 之后没有新内容时不重复');

console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 2: 运行测试确认通过**

```bash
node tests/ai-jobs.mjs
```

Expected: `全部通过：7 项`。

- [ ] **Step 3: 提交**

```bash
git add tests/ai-jobs.mjs
git commit -m "test(ai): 任务判定与增量输出的离线用例"
```

---

### Task 11: 更新项目规则

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: Task 1–10 的最终实现
- Produces: 无

- [ ] **Step 1: 新增小节**

在 `CLAUDE.md` 的 `## IPC 约定` 之前插入：

```markdown
## AI 控制面（MCP）

`desktop/pane-api.js` 是传输层（HTTP 路由 + token + JSON-RPC），工具实现分在
`desktop/ai-tools/` 下，**不要把它重新写成一个什么都装的大文件**。

- **主进程要渲染进程做事必须走 `desktop/ai-bridge.js`**。现有通道（`panes:sync`、
  `browser:open-url`）都是单向 `send`，拿不到返回值；建页签的代码在渲染进程
  （`App.tsx` 的 `createTerminal` / `createBrowser`），主进程只能委托。
- **桥接 op 与 MCP 工具名是两套命名**：op 用 kebab-case（`create-terminal`），
  MCP 工具名用 snake_case（`open_terminal`）。改名字时两处都要改。
- **窗口未就绪时 `aiBridge.request` 立即 reject（`ui-unavailable`），不排队**。
  排队会让 AI 以为操作已被接受。
- **`terminal_run` 的结束条件有三个**：进程退出、连续 `quietMs`（默认 1200ms）无输出、
  总超时（默认 60s，上限 10 分钟）。交互式命令不会退出，靠「安静」判定这一轮结束。
  三个条件缺一不可。
- **返回给 AI 的输出必须过 `cleanOutput`**（`ai-tools/ansi.js`）：pty 里全是 CSI/OSC
  序列与 `\r` 重绘，不清理等于给 AI 一堆乱码。注意**不要**改 `ptyHost.getLastOutput`
  的原始缓冲——`get_pane_content` 仍需要原始输出。
- **cursor 以「已读字符数」计，不用行号**：行号会在尾部半行上重复或丢弃内容。
- **同一 pane 不允许并发 `terminal_run`**，后到的返回 `pane-busy` 并带上正在跑的 jobId；
  否则两条命令的输出会交错，谁都读不准。
- **job 只存在内存里**，绑定 sessionId；session 关闭或应用退出即丢弃，不落盘。
- **`terminal_run` 不传 pane 时复用 AI 终端页签**：同项目内 `aiOwned && !exited &&
  无正在跑的任务`，没有才新建。AI 页签标题固定「AI 终端」，不随命令变化，
  避免连续执行时标题反复跳。
- **AI 页签的 `aiOwned` 字段要能被会话恢复**（`desktop/session.js` 的 `normalizeTab`），
  否则重启后标记丢失、空页签会被别的任务误复用。
- `tests/ai-ansi.mjs`、`tests/ai-jobs.mjs` 是离线用例；`tests/ai-bridge.mjs` 是端到端，
  必须独占 17382 端口。
```

- [ ] **Step 2: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: 记录 AI 控制面的桥接、输出清理与任务判定约定"
```

---

## 验收清单

- [ ] `node tests/ai-ansi.mjs`、`node tests/ai-jobs.mjs` 全绿
- [ ] `npx tsc --noEmit && npx vite build` 无报错
- [ ] `node tests/ai-bridge.mjs` 全绿（独占运行）
- [ ] 既有测试未回归：`node tests/git-panel.mjs`、`node tests/pane-ref.mjs`
- [ ] 手动确认：在 Claude 里说「在新终端跑 echo hello」，应用弹出带 AI 标记的终端页签并回显
