# 编辑器页签实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Cmd Toolbox 增加一个 `editor` 页签：左侧按需加载的文件树，右侧 CodeMirror 编辑器，支持编码保持的读写。

**Architecture:** 主进程新增 `desktop/file-api.js` 负责目录列举、带编码检测的读写，路径校验从 `git.js` 抽出为 `desktop/path-guard.js` 共用；渲染侧新增 `EditorPane` 组件与 `useEditorFile` 钩子，作为第三种页签类型接入现有 `renderWorkbenchPane` 分支。

**Tech Stack:** Electron 33、React 19、TypeScript、CodeMirror 6、iconv-lite、Playwright（`_electron`）

**规格：** `docs/superpowers/specs/2026-10-27-git-editor-design.md`

## Global Constraints

- 项目根目录：`D:\deskTop\CmdToolbox\cmd-toolbox`（git 仓库，基线 `d7e87f8`）
- 所有新依赖装到 `devDependencies`（与现有 `@xterm/*`、`lucide-react` 一致，Vite 会打包进 `dist`）
- 所有文件系统 IPC 必须经 `assertProjectPath` 白名单（`desktop/main.js` 已存在）
- 路径解析后必须落在项目根目录内；已存在的路径还要过 `fs.realpath`
- 读取上限 2MB；含 NUL 字节判为二进制
- 写入采用临时文件 + `rename`
- 编辑器只读时不写盘
- 文案使用中文
- 代码风格：2 空格、单引号、`cn()` 拼类名、`toErrorMessage()` 转错误文案
- 构建验证用 `npm run typecheck && npx vite build`；**不要**用 `npm run build`（它会额外编译 native helper，与前端无关且更慢）

## 现有代码中需要知道的约定

- `Tab.shellId` 复用为页签种类标识：`'browser'` 是浏览器，其余是终端
- `isBrowserTab(tab)` 在 `src/types.ts`，判断 `shellId === 'browser'`
- `renderWorkbenchPane(tab)` 在 `src/App.tsx`，按种类分派到 `BrowserPane` / `TerminalPane`
- `createBrowser(group)` 是浏览器页签的创建器，可作模板
- 会话持久化在 `desktop/session.js`，`normalizeTab` 只保留固定字段
- `nextPaneNo(paneNos)` 在 `src/lib.ts`
- 项目右键菜单在 `openGroupMenu`（`src/App.tsx`）

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `desktop/path-guard.js` | 新增。`resolveWithin(root, relPath)`，供 git 与文件 API 共用 |
| `desktop/file-api.js` | 新增。`list` / `read` / `write`，含编码检测 |
| `desktop/git.js` | 修改。`diffCommand` 改用 `path-guard` |
| `desktop/main.js` | 修改。注册 3 个 IPC |
| `desktop/preload.js` | 修改。暴露 `window.api.files` |
| `desktop/session.js` | 修改。`normalizeTab` 保留 `filePath` |
| `src/types.ts` | 修改。`Tab.filePath`、`isEditorTab`、`FileEntry` |
| `src/global.d.ts` | 修改。补类型 |
| `src/useEditorFile.ts` | 新增。打开 / 编辑 / 保存的状态钩子 |
| `src/editorLanguage.ts` | 新增。按扩展名选语言包（动态导入） |
| `src/components/FileTree.tsx` | 新增。按需加载的树 |
| `src/components/CodeMirrorHost.tsx` | 新增。CodeMirror 挂载与销毁 |
| `src/components/EditorPane.tsx` | 新增。工具栏 + 树 + 编辑器 |
| `src/App.tsx` | 修改。页签分派、创建器、右键菜单、会话恢复 |
| `src/styles.css` | 修改。编辑器与树样式 |
| `tests/editor.mjs` | 新增。端到端测试 |

---

### Task 1: 路径守卫与文件读写

**Files:**
- Create: `desktop/path-guard.js`
- Create: `desktop/file-api.js`
- Modify: `desktop/git.js`
- Test: `tests/file-api.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `pathGuard.resolveWithin(root: string, relPath: string) => string`（返回绝对路径，越界抛错）
  - `fileApi.list(projectPath: string, relDir: string) => Promise<{ entries: FileEntry[] }>`
  - `fileApi.read(projectPath: string, relPath: string) => Promise<{ content, encoding, size, readOnly, mtime }>`
  - `fileApi.write(projectPath: string, relPath: string, content: string, encoding: string, mtime: number) => Promise<{ ok: true }>`
  - `FileEntry = { name: string; relPath: string; isDir: boolean; isSymlink: boolean }`

- [ ] **Step 1: 安装依赖**

```bash
npm install --save-dev iconv-lite@^0.6.3
```

- [ ] **Step 2: 写失败的测试**

创建 `tests/file-api.mjs`：

```js
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fileApi = require('../desktop/file-api.js');
const pathGuard = require('../desktop/path-guard.js');
const iconv = require('iconv-lite');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const repo = mkdtempSync(join(tmpdir(), 'cmdtb-fs-'));
mkdirSync(join(repo, 'src'));
writeFileSync(join(repo, 'index.php'), '<?php echo 1;\n');
writeFileSync(join(repo, 'src', 'app.js'), 'console.log(1);\n');
mkdirSync(join(repo, 'node_modules'));
writeFileSync(join(repo, 'node_modules', 'x.js'), 'x\n');

console.log('1. 列目录');
const root = await fileApi.list(repo, '');
assert(root.entries.some((e) => e.name === 'index.php' && !e.isDir), '列出根目录文件');
assert(root.entries.some((e) => e.name === 'src' && e.isDir), '目录标记为 isDir');
assert(!root.entries.some((e) => e.name === 'node_modules'), '忽略 node_modules');
assert(root.entries[0].isDir, '目录排在文件前面');
const sub = await fileApi.list(repo, 'src');
assert(sub.entries.length === 1 && sub.entries[0].relPath === 'src/app.js', '子目录 relPath 正确');

console.log('2. 读 UTF-8');
const utf8 = await fileApi.read(repo, 'index.php');
assert(utf8.content === '<?php echo 1;\n', '内容正确');
assert(utf8.encoding === 'utf8', '识别为 utf8');
assert(utf8.readOnly === false, '可写');
assert(typeof utf8.mtime === 'number' && utf8.mtime > 0, '返回 mtime');

console.log('3. 读写 GBK');
const gbkBuf = iconv.encode('中文内容\n', 'gbk');
writeFileSync(join(repo, 'gbk.txt'), gbkBuf);
const gbk = await fileApi.read(repo, 'gbk.txt');
assert(gbk.content === '中文内容\n', 'GBK 正确解码');
assert(gbk.encoding === 'gbk', '识别为 gbk');
await fileApi.write(repo, 'gbk.txt', '新的中文\n', 'gbk', gbk.mtime);
const written = readFileSync(join(repo, 'gbk.txt'));
assert(Buffer.compare(written, iconv.encode('新的中文\n', 'gbk')) === 0, '按 GBK 写回，字节一致');

console.log('4. UTF-8 BOM 往返');
writeFileSync(join(repo, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('带BOM\n')]));
const bom = await fileApi.read(repo, 'bom.txt');
assert(bom.content === '带BOM\n', 'BOM 已剥离');
assert(bom.encoding === 'utf8bom', '识别为 utf8bom');
await fileApi.write(repo, 'bom.txt', '改过\n', 'utf8bom', bom.mtime);
const bomOut = readFileSync(join(repo, 'bom.txt'));
assert(bomOut[0] === 0xef && bomOut[1] === 0xbb && bomOut[2] === 0xbf, '写回时保留 BOM');
assert(bomOut.slice(3).toString('utf8') === '改过\n', 'BOM 后内容正确');

console.log('5. 二进制只读');
writeFileSync(join(repo, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
const bin = await fileApi.read(repo, 'bin.dat');
assert(bin.readOnly === true, '二进制标记为只读');
assert(bin.content === '', '二进制不返回内容');

console.log('6. 大文件只读');
writeFileSync(join(repo, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 10));
const big = await fileApi.read(repo, 'big.txt');
assert(big.readOnly === true, '超过 2MB 只读');
assert(big.size > 2 * 1024 * 1024, '返回实际大小');

console.log('7. mtime 冲突');
const stale = await fileApi.read(repo, 'index.php');
writeFileSync(join(repo, 'index.php'), '外部改动\n');
let staleRejected = '';
try {
  await fileApi.write(repo, 'index.php', '我的改动\n', 'utf8', stale.mtime);
} catch (error) {
  staleRejected = error.message;
}
assert(staleRejected.includes('外部'), 'mtime 不匹配时拒绝写入');
assert(readFileSync(join(repo, 'index.php'), 'utf8') === '外部改动\n', '原文件未被覆盖');

console.log('8. 路径越界');
for (const bad of ['../outside.txt', 'src/../../x.txt', '/etc/passwd']) {
  let rejected = false;
  try {
    pathGuard.resolveWithin(repo, bad);
  } catch {
    rejected = true;
  }
  assert(rejected, `拒绝路径 ${bad}`);
}
let readRejected = false;
try {
  await fileApi.read(repo, '../outside.txt');
} catch {
  readRejected = true;
}
assert(readRejected, 'read 拒绝越界路径');

console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node tests/file-api.mjs`
Expected: FAIL，`Cannot find module '../desktop/file-api.js'`

- [ ] **Step 4: 实现 `desktop/path-guard.js`**

```js
const fs = require('fs');
const path = require('path');

// 解析 relPath 并确保结果落在 root 内；已存在的路径再做 realpath 校验，防符号链接逃逸。
function resolveWithin(root, relPath) {
  const base = path.resolve(root);
  const relative = String(relPath || '');
  if (relative.includes('\0')) throw new Error('路径包含非法字符');

  const target = path.resolve(base, relative);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('路径不在项目目录内');
  }

  try {
    const realBase = fs.realpathSync(base);
    const realTarget = fs.realpathSync(target);
    const realRel = path.relative(realBase, realTarget);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error('路径不在项目目录内');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return target;
}

module.exports = { resolveWithin };
```

- [ ] **Step 5: 实现 `desktop/file-api.js`**

```js
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const iconv = require('iconv-lite');
const { resolveWithin } = require('./path-guard');

const MAX_READ_BYTES = 2 * 1024 * 1024;
const IGNORED = new Set(['.git', 'node_modules', 'dist', 'release', 'release-build']);

function isIgnored(name) {
  return IGNORED.has(name) || name.startsWith('release-build');
}

async function list(projectPath, relDir) {
  const dir = resolveWithin(projectPath, relDir || '');
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const mapped = entries
    .filter((entry) => !isIgnored(entry.name))
    .map((entry) => ({
      name: entry.name,
      relPath: path.join(relDir || '', entry.name).split(path.sep).join('/'),
      isDir: entry.isDirectory(),
      isSymlink: entry.isSymbolicLink(),
    }));

  mapped.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  return { entries: mapped };
}

function detectEncoding(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { encoding: 'utf8bom', offset: 3 };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { encoding: 'utf16le', offset: 2 };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { encoding: 'utf16be', offset: 2 };
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { encoding: 'utf8', offset: 0 };
  } catch {
    return { encoding: 'gbk', offset: 0 };
  }
}

function decodeContent(buffer, encoding, offset) {
  const body = buffer.subarray(offset);
  if (encoding === 'utf8' || encoding === 'utf8bom') return body.toString('utf8');
  if (encoding === 'utf16le') return iconv.decode(body, 'utf16-le');
  if (encoding === 'utf16be') return iconv.decode(body, 'utf16-be');
  return iconv.decode(body, 'gbk');
}

function encodeContent(content, encoding) {
  if (encoding === 'utf8bom') {
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')]);
  }
  if (encoding === 'utf16le') return iconv.encode(content, 'utf16-le');
  if (encoding === 'utf16be') return iconv.encode(content, 'utf16-be');
  if (encoding === 'gbk') return iconv.encode(content, 'gbk');
  return Buffer.from(content, 'utf8');
}

async function read(projectPath, relPath) {
  const target = resolveWithin(projectPath, relPath);
  const stat = await fsp.stat(target);

  if (stat.size > MAX_READ_BYTES) {
    return {
      content: '',
      encoding: 'utf8',
      size: stat.size,
      readOnly: true,
      mtime: stat.mtimeMs,
    };
  }

  const buffer = await fsp.readFile(target);
  if (buffer.includes(0)) {
    return {
      content: '',
      encoding: 'utf8',
      size: stat.size,
      readOnly: true,
      mtime: stat.mtimeMs,
    };
  }

  const { encoding, offset } = detectEncoding(buffer);
  return {
    content: decodeContent(buffer, encoding, offset),
    encoding,
    size: stat.size,
    readOnly: false,
    mtime: stat.mtimeMs,
  };
}

async function write(projectPath, relPath, content, encoding, mtime) {
  const target = resolveWithin(projectPath, relPath);
  const stat = await fsp.stat(target);

  if (typeof mtime === 'number' && Math.abs(stat.mtimeMs - mtime) > 1) {
    throw new Error('文件已在外部修改，请重新打开');
  }

  const buffer = encodeContent(String(content ?? ''), encoding || 'utf8');
  const temp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temp, buffer);
  await fsp.rename(temp, target);
  return { ok: true };
}

module.exports = { list, read, write, detectEncoding };
```

- [ ] **Step 6: 让 `git.js` 复用路径守卫**

在 `desktop/git.js` 顶部加入：

```js
const { resolveWithin } = require('./path-guard');
```

把 `diffCommand` 中的这段：

```js
  const root = path.resolve(projectPath);
  const target = path.resolve(root, String(filePath || ''));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('文件路径不在项目目录内');
  }
```

替换为：

```js
  const root = path.resolve(projectPath);
  const target = resolveWithin(root, String(filePath || ''));
  const relative = path.relative(root, target);
  if (!relative) {
    throw new Error('文件路径不在项目目录内');
  }
```

- [ ] **Step 7: 运行测试确认通过**

Run: `node tests/file-api.mjs`
Expected: 全部通过
Run: `node tests/git-core.mjs`
Expected: 仍然全部通过（20 项，验证 git.js 重构没有破坏原有行为）

- [ ] **Step 8: 提交**

```bash
git add desktop/path-guard.js desktop/file-api.js desktop/git.js tests/file-api.mjs package.json package-lock.json
git commit -m "feat(fs): add file api with encoding detection and shared path guard"
```

---

### Task 2: 文件系统 IPC

**Files:**
- Modify: `desktop/main.js`
- Modify: `desktop/preload.js`
- Modify: `src/types.ts`
- Modify: `src/global.d.ts`
- Test: `tests/editor-ipc.mjs`

**Interfaces:**
- Consumes: Task 1 的 `fileApi.list/read/write`
- Produces:
  - `window.api.files.list(projectPath, relDir)`
  - `window.api.files.read(projectPath, relPath)`
  - `window.api.files.write(projectPath, relPath, content, encoding, mtime)`
  - `FileEntry` 类型

- [ ] **Step 1: 写失败的测试**

创建 `tests/editor-ipc.mjs`：

```js
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-data-'));
const repo = mkdtempSync(join(tmpdir(), 'cmdtb-ipc-fs-'));
mkdirSync(join(repo, 'src'));
writeFileSync(join(repo, 'index.php'), '<?php echo 1;\n');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
  cwd: root,
  args: ['.', `--data-dir=${dataDir}`],
  env,
});
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.locator('.app').waitFor();
await page.waitForTimeout(1200);

await page.evaluate((p) => window.api.projects.save({ name: 'fs-proj', path: p }), repo);

const listed = await page.evaluate((p) => window.api.files.list(p, ''), repo);
assert(listed.entries.some((e) => e.name === 'index.php'), 'IPC 列出文件');

const read = await page.evaluate((p) => window.api.files.read(p, 'index.php'), repo);
assert(read.content === '<?php echo 1;\n', 'IPC 读取内容');
assert(read.encoding === 'utf8', 'IPC 返回编码');

await page.evaluate(
  ([p, mtime]) => window.api.files.write(p, 'index.php', '<?php echo 2;\n', 'utf8', mtime),
  [repo, read.mtime],
);
const reread = await page.evaluate((p) => window.api.files.read(p, 'index.php'), repo);
assert(reread.content === '<?php echo 2;\n', 'IPC 写入生效');

let blocked = '';
try {
  await page.evaluate(() => window.api.files.read('C:\\Windows', 'win.ini'));
} catch (error) {
  blocked = error.message;
}
assert(blocked.includes('未保存'), '未保存项目被白名单拒绝');

await app.close();
rmSync(dataDir, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/editor-ipc.mjs`
Expected: FAIL，`window.api.files` 为 undefined

（若因端口 17382 被占用而启动超时，说明本机有 Cmd Toolbox 实例在跑。此时改用隔离副本：把 `desktop/`、`dist/`、`package.json` 复制到临时目录，`node_modules` 用目录联接指回原处，把 `pane-api.js` 的 `DEFAULT_PORT` 改成 17997，删掉 `main.js` 里的 `mcpConfig.installGlobal(mcp);` 一行，再把测试的 `cwd` 指向该副本。）

- [ ] **Step 3: 注册 IPC**

`desktop/main.js` 顶部 require 区加入：

```js
const fileApi = require('./file-api');
```

在 `git:diff` handler 之后插入：

```js
  ipcMain.handle('fs:list', (_event, projectPath, relDir) =>
    fileApi.list(assertProjectPath(projectPath), relDir),
  );

  ipcMain.handle('fs:read', (_event, projectPath, relPath) =>
    fileApi.read(assertProjectPath(projectPath), relPath),
  );

  ipcMain.handle('fs:write', (_event, projectPath, relPath, content, encoding, mtime) =>
    fileApi.write(assertProjectPath(projectPath), relPath, content, encoding, mtime),
  );
```

- [ ] **Step 4: 暴露到 preload**

`desktop/preload.js` 的 `git:` 段之后加入：

```js
  files: {
    list: (projectPath, relDir) => invoke('fs:list', projectPath, relDir),
    read: (projectPath, relPath) => invoke('fs:read', projectPath, relPath),
    write: (projectPath, relPath, content, encoding, mtime) =>
      invoke('fs:write', projectPath, relPath, content, encoding, mtime),
  },
```

- [ ] **Step 5: 补类型**

`src/types.ts` 末尾追加：

```ts
export type FileEntry = {
  name: string;
  relPath: string;
  isDir: boolean;
  isSymlink: boolean;
};

export type OpenedFile = {
  content: string;
  encoding: string;
  size: number;
  readOnly: boolean;
  mtime: number;
};
```

`src/global.d.ts` 的 `import type` 改为：

```ts
import type { AppInfo, FileEntry, GitChange, GitStatus, OpenedFile, Project } from './types';
```

在 `Window.api` 的 `git` 段之后加入：

```ts
      files: {
        list: (projectPath: string, relDir: string) => Promise<{ entries: FileEntry[] }>;
        read: (projectPath: string, relPath: string) => Promise<OpenedFile>;
        write: (
          projectPath: string,
          relPath: string,
          content: string,
          encoding: string,
          mtime: number,
        ) => Promise<{ ok: true }>;
      };
```

- [ ] **Step 6: 验证**

Run: `npm run typecheck && npx vite build`
Expected: 均通过
Run: `node tests/editor-ipc.mjs`
Expected: 全部通过

- [ ] **Step 7: 提交**

```bash
git add desktop/main.js desktop/preload.js src/types.ts src/global.d.ts tests/editor-ipc.mjs
git commit -m "feat(fs): expose file system IPC to renderer"
```

---

### Task 3: 编辑器页签类型

**Files:**
- Modify: `src/types.ts`
- Modify: `desktop/session.js`
- Modify: `src/App.tsx`
- Modify: `src/components/TabStrip.tsx`

**Interfaces:**
- Consumes: Task 2 的 `FileEntry`
- Produces:
  - `Tab.filePath?: string`
  - `isEditorTab(tab) => boolean`
  - `createEditor(group: Group, filePath?: string) => void`
  - `openEditorFile(group: Group, relPath: string) => void`

- [ ] **Step 1: 补类型与判断函数**

`src/types.ts` 的 `Tab` 类型加入：

```ts
  filePath?: string;
```

`isBrowserTab` 之后加入：

```ts
export function isEditorTab(tab: { shellId: string }): boolean {
  return tab.shellId === 'editor';
}
```

- [ ] **Step 2: 会话持久化保留 filePath**

`desktop/session.js` 的 `normalizeTab` 返回对象里，`conversationId` 之后加入：

```js
    filePath: typeof value.filePath === 'string' ? value.filePath.trim().slice(0, 500) : '',
```

`src/App.tsx` 中保存会话的 `.map((tab) => ({ ... }))`（约 `src/App.tsx:589`）加入：

```tsx
          filePath: tab.filePath || '',
```

- [ ] **Step 3: 创建编辑器页签**

`src/App.tsx` 中 `createBrowser` 之后加入：

```tsx
  const createEditor = useCallback(
    (group: Group, filePath = '') => {
      if (!group.exists) {
        pushToast('项目目录不存在，请先编辑项目路径', 'error');
        return;
      }
      const groupTabs = tabsRef.current[group.key] || [];
      const tab: Tab = {
        id: crypto.randomUUID(),
        groupKey: group.key,
        sessionId: '',
        shellId: 'editor',
        seq: 1,
        paneNo: nextPaneNo(groupTabs.map((item) => item.paneNo)),
        descriptor: '编辑器',
        custom: false,
        cwd: group.path,
        filePath,
        exited: false,
      };
      applyTabs({ ...tabsRef.current, [group.key]: [...groupTabs, tab] });
      setActiveGroupKey(group.key);
      setActiveTabByGroup((previous) => ({ ...previous, [group.key]: tab.id }));
    },
    [applyTabs, pushToast],
  );
```

- [ ] **Step 4: 分派渲染**

`src/App.tsx` 的 `renderWorkbenchPane` 中，`if (isBrowserTab(tab))` 分支之后加入：

```tsx
    if (isEditorTab(tab)) {
      return (
        <EditorPane
          key={tab.id}
          tab={tab}
          group={group}
          active={active}
          onClose={(target) => closeTabs(target.groupKey, [target.id])}
          onToast={pushToast}
          onTitleChange={(title) => setTabDescriptor(tab.groupKey, tab.id, title)}
        />
      );
    }
```

import 区加入：

```tsx
import { EditorPane } from './components/EditorPane';
import { isEditorTab } from './types';
```

`isEditorTab` 与 `isBrowserTab` 在同一行 import，改为：

```tsx
import { GLOBAL_GROUP_KEY, isBrowserTab, isEditorTab, projectGroupKey } from './types';
```

- [ ] **Step 5: 加上 setTabDescriptor**

先确认是否已有重命名逻辑。`src/App.tsx` 中已有 `renameTarget` 状态与保存逻辑；本任务新增一个直接改标题的小工具，放在 `createEditor` 之前：

```tsx
  const setTabDescriptor = useCallback(
    (groupKey: string, tabId: string, descriptor: string) => {
      applyTabs({
        ...tabsRef.current,
        [groupKey]: (tabsRef.current[groupKey] || []).map((item) =>
          item.id === tabId ? { ...item, descriptor, custom: true } : item,
        ),
      });
    },
    [applyTabs],
  );
```

- [ ] **Step 6: 会话恢复支持编辑器**

`src/App.tsx` 中 `if (saved.shellId === 'browser')` 分支之后、终端恢复分支之前加入：

```tsx
          if (saved.shellId === 'editor') {
            restoredTabs[saved.groupKey] = [
              ...existing,
              {
                id: saved.id,
                groupKey: saved.groupKey,
                sessionId: '',
                shellId: 'editor',
                seq: saved.seq || 1,
                paneNo,
                descriptor: saved.descriptor || '编辑器',
                custom: saved.custom,
                cwd: group.path,
                filePath: saved.filePath || '',
                exited: false,
              },
            ];
            continue;
          }
```

`SessionTab` 接口（`src/global.d.ts`）加入：

```ts
  filePath?: string;
```

- [ ] **Step 7: 页签图标**

`src/App.tsx` 的 `shellIcon` 函数中，`if (shellId === 'browser')` 之前加入：

```tsx
  if (shellId === 'editor') return <FileCode size={14} />;
```

`lucide-react` import 中加入 `FileCode`。

- [ ] **Step 8: 临时占位组件**

创建 `src/components/EditorPane.tsx` 占位版本，让 Task 3 可独立编译与验证（Task 4/5 会替换它）：

```tsx
import type { Group, Tab } from '../types';
import type { ToastKind } from './Toast';

export type EditorPaneProps = {
  tab: Tab;
  group: Group;
  active: boolean;
  onClose: (tab: Tab) => void;
  onToast: (message: string, kind?: ToastKind) => void;
  onTitleChange: (title: string) => void;
};

export function EditorPane({ tab, group, active }: EditorPaneProps) {
  return (
    <section className={`terminal-pane editor-pane${active ? '' : ' is-hidden'}`}>
      <header className="pane-header">
        <span className="pane-path">{group.name}</span>
      </header>
      <div className="editor-body">
        <p className="editor-placeholder">{tab.filePath || '尚未打开文件'}</p>
      </div>
    </section>
  );
}
```

- [ ] **Step 9: 打开入口（右键菜单）**

`src/App.tsx` 的 `openGroupMenu` 中，`group-reveal` 项之后加入：

```tsx
        {
          type: 'item',
          id: 'group-editor',
          label: '打开编辑器',
          icon: <FileCode size={14} />,
          disabled: !group.exists,
          onSelect: () => createEditor(group),
        },
```

依赖数组加入 `createEditor`。

- [ ] **Step 10: 验证**

Run: `npm run typecheck && npx vite build`
Expected: 均通过
Run: `node tests/git-panel.mjs`
Expected: 仍然 12/12 通过（回归）

- [ ] **Step 11: 提交**

```bash
git add src/types.ts src/App.tsx src/components/EditorPane.tsx desktop/session.js
git commit -m "feat(editor): add editor tab type and open entry"
```

---

### Task 4: 文件树与编辑器主体

**Files:**
- Create: `src/editorLanguage.ts`
- Create: `src/components/CodeMirrorHost.tsx`
- Create: `src/components/FileTree.tsx`
- Modify: `src/components/EditorPane.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `window.api.files.*`（Task 2）、`Tab.filePath`（Task 3）
- Produces:
  - `languageFor(filePath: string) => Promise<Extension | null>`
  - `CodeMirrorHost` props `{ value, readOnly, filePath, onChange }`
  - `FileTree` props `{ group, activePath, onOpen }`

- [ ] **Step 1: 安装 CodeMirror**

```bash
npm install --save-dev codemirror@^6 @codemirror/lang-php@^6 @codemirror/lang-html@^6 @codemirror/lang-css@^6 @codemirror/lang-javascript@^6 @codemirror/lang-json@^6 @codemirror/lang-markdown@^6 @codemirror/search@^6 @codemirror/state@^6 @codemirror/view@^6
```

- [ ] **Step 2: 语言映射**

创建 `src/editorLanguage.ts`：

```ts
import type { Extension } from '@codemirror/state';

const EXTENSION_MAP: Record<string, () => Promise<Extension>> = {
  php: () => import('@codemirror/lang-php').then((m) => m.php()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  htm: () => import('@codemirror/lang-html').then((m) => m.html()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  js: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  mjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  cjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  ts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  tsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  md: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
};

export async function languageFor(filePath: string): Promise<Extension | null> {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const loader = EXTENSION_MAP[ext];
  if (!loader) return null;
  try {
    return await loader();
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: CodeMirror 宿主组件**

创建 `src/components/CodeMirrorHost.tsx`：

```tsx
import { useEffect, useRef } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { languageFor } from '../editorLanguage';

export type CodeMirrorHostProps = {
  value: string;
  filePath: string;
  readOnly: boolean;
  onChange: (value: string) => void;
};

export function CodeMirrorHost({ value, filePath, readOnly, onChange }: CodeMirrorHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageRef = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 只在 filePath / readOnly 变化时重建，避免每次按键都销毁编辑器
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          highlightSelectionMatches(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.lineWrapping,
          languageRef.current.of([]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          EditorState.readOnly.of(readOnly),
        ],
      }),
    });
    viewRef.current = view;

    void languageFor(filePath).then((extension) => {
      if (disposed || !extension) return;
      view.dispatch({
        effects: languageRef.current.reconfigure(extension),
      });
    });

    return () => {
      disposed = true;
      view.destroy();
      viewRef.current = null;
    };
    // value 故意不放进依赖：由外部内容变化通过下方 effect 同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, readOnly]);

  // 文件内容被外部替换（如重新加载）时，同步到编辑器
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return <div className="codemirror-host" ref={hostRef} />;
}
```

`@codemirror/commands` 由 `codemirror` 包间接引入；若 `npm run typecheck` 报找不到该模块，显式安装：

```bash
npm install --save-dev @codemirror/commands@^6
```

- [ ] **Step 4: 文件树组件**

创建 `src/components/FileTree.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, File, Folder, FolderOpen } from 'lucide-react';
import { cn, toErrorMessage } from '../lib';
import type { FileEntry, Group } from '../types';

type FileTreeProps = {
  group: Group;
  activePath: string;
  onOpen: (relPath: string) => void;
  onError: (message: string) => void;
};

type DirState = Record<string, FileEntry[] | undefined>;

export function FileTree({ group, activePath, onOpen, onError }: FileTreeProps) {
  const [children, setChildren] = useState<DirState>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));

  const loadDir = useCallback(
    async (relDir: string) => {
      try {
        const result = await window.api.files.list(group.path, relDir);
        setChildren((previous) => ({ ...previous, [relDir]: result.entries }));
      } catch (error) {
        onError(toErrorMessage(error));
      }
    },
    [group.path, onError],
  );

  useEffect(() => {
    setChildren({});
    setExpanded(new Set(['']));
    void loadDir('');
  }, [group.key, loadDir]);

  const toggle = (relPath: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(relPath)) next.delete(relPath);
      else {
        next.add(relPath);
        if (!children[relPath]) void loadDir(relPath);
      }
      return next;
    });
  };

  const renderDir = (relDir: string, depth: number): JSX.Element[] => {
    const entries = children[relDir] || [];
    return entries.flatMap((entry) => {
      const isOpen = expanded.has(entry.relPath);
      const row = (
        <button
          key={entry.relPath}
          type="button"
          className={cn(
            'file-row',
            entry.relPath === activePath && 'active',
            entry.isSymlink && 'is-disabled',
          )}
          style={{ paddingLeft: 8 + depth * 12 }}
          title={entry.relPath}
          disabled={entry.isSymlink}
          onClick={() => (entry.isDir ? toggle(entry.relPath) : onOpen(entry.relPath))}
        >
          {entry.isDir ? (
            isOpen ? <ChevronRight size={12} className="file-caret open" /> : <ChevronRight size={12} className="file-caret" />
          ) : (
            <span className="file-caret-spacer" />
          )}
          {entry.isDir ? (
            isOpen ? <FolderOpen size={13} /> : <Folder size={13} />
          ) : (
            <File size={13} />
          )}
          <span className="file-name">{entry.name}</span>
        </button>
      );
      if (!entry.isDir || !isOpen) return [row];
      return [row, ...renderDir(entry.relPath, depth + 1)];
    });
  };

  return <div className="file-tree">{renderDir('', 0)}</div>;
}
```

- [ ] **Step 5: 编辑器的打开与保存钩子**

创建 `src/useEditorFile.ts`：

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { toErrorMessage } from './lib';
import type { Group, OpenedFile } from './types';

export type EditorFileState = {
  relPath: string;
  content: string;
  savedContent: string;
  encoding: string;
  mtime: number;
  readOnly: boolean;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
};

const EMPTY: EditorFileState = {
  relPath: '',
  content: '',
  savedContent: '',
  encoding: 'utf8',
  mtime: 0,
  readOnly: false,
  loading: false,
  saving: false,
  dirty: false,
};

export function useEditorFile(group: Group, onError: (message: string) => void) {
  const [file, setFile] = useState<EditorFileState>(EMPTY);
  const groupRef = useRef(group);
  groupRef.current = group;

  const open = useCallback(
    async (relPath: string) => {
      setFile((previous) => ({ ...previous, relPath, loading: true }));
      try {
        const result: OpenedFile = await window.api.files.read(groupRef.current.path, relPath);
        setFile({
          relPath,
          content: result.content,
          savedContent: result.content,
          encoding: result.encoding,
          mtime: result.mtime,
          readOnly: result.readOnly,
          loading: false,
          saving: false,
          dirty: false,
        });
      } catch (error) {
        onError(toErrorMessage(error));
        setFile(EMPTY);
      }
    },
    [onError],
  );

  const update = useCallback((content: string) => {
    setFile((previous) => ({
      ...previous,
      content,
      dirty: content !== previous.savedContent,
    }));
  }, []);

  const save = useCallback(async () => {
    const current = file;
    if (!current.relPath || current.readOnly) return false;
    setFile((previous) => ({ ...previous, saving: true }));
    try {
      const before = await window.api.files.read(groupRef.current.path, current.relPath);
      await window.api.files.write(
        groupRef.current.path,
        current.relPath,
        current.content,
        current.encoding,
        before.mtime,
      );
      setFile((previous) => ({
        ...previous,
        savedContent: previous.content,
        dirty: false,
        saving: false,
        mtime: before.mtime,
      }));
      return true;
    } catch (error) {
      onError(toErrorMessage(error));
      setFile((previous) => ({ ...previous, saving: false }));
      return false;
    }
  }, [file, onError]);

  useEffect(() => {
    setFile(EMPTY);
  }, [group.key]);

  return { file, open, update, save };
}
```

- [ ] **Step 6: 组装 EditorPane**

用下面内容替换 `src/components/EditorPane.tsx`：

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { Save, X } from 'lucide-react';
import { toErrorMessage } from '../lib';
import { useEditorFile } from '../useEditorFile';
import { FileTree } from './FileTree';
import { CodeMirrorHost } from './CodeMirrorHost';
import type { Group, Tab } from '../types';
import type { ToastKind } from './Toast';

const ENCODING_LABEL: Record<string, string> = {
  utf8: 'UTF-8',
  utf8bom: 'UTF-8 BOM',
  utf16le: 'UTF-16 LE',
  utf16be: 'UTF-16 BE',
  gbk: 'GBK',
};

export type EditorPaneProps = {
  tab: Tab;
  group: Group;
  active: boolean;
  onClose: (tab: Tab) => void;
  onToast: (message: string, kind?: ToastKind) => void;
  onTitleChange: (title: string) => void;
};

export function EditorPane({ tab, group, active, onClose, onToast, onTitleChange }: EditorPaneProps) {
  const onError = useCallback((message: string) => onToast(message, 'error'), [onToast]);
  const { file, open, update, save } = useEditorFile(group, onError);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const fileRef = useRef(file);
  fileRef.current = file;

  useEffect(() => {
    if (tab.filePath && tab.filePath !== file.relPath) void open(tab.filePath);
  }, [tab.filePath, file.relPath, open]);

  useEffect(() => {
    const base = file.relPath ? file.relPath.split('/').pop() || '编辑器' : '编辑器';
    onTitleChange(`${group.name} · ${base}${file.dirty ? ' •' : ''}`);
  }, [file.relPath, file.dirty, group.name, onTitleChange]);

  const requestOpen = (relPath: string) => {
    if (fileRef.current.dirty) {
      setPendingPath(relPath);
      return;
    }
    void open(relPath);
  };

  const handleSave = useCallback(async () => {
    if (fileRef.current.readOnly) {
      onToast('该文件为只读，无法保存', 'error');
      return;
    }
    const ok = await save();
    if (ok) onToast('已保存', 'success');
  }, [onToast, save]);

  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active, handleSave]);

  const requestClose = () => {
    if (file.dirty) {
      const ok = window.confirm(`「${file.relPath}」有未保存的修改，关闭将丢失。是否继续？`);
      if (!ok) return;
    }
    onClose(tab);
  };

  return (
    <section className={`terminal-pane editor-pane${active ? '' : ' is-hidden'}`}>
      <header className="pane-header">
        <span className="pane-path" title={file.relPath || group.path}>
          {file.relPath || group.name}
        </span>
        <span className="editor-encoding">{ENCODING_LABEL[file.encoding] || file.encoding}</span>
        <button
          type="button"
          className="icon-btn"
          title="保存 (Ctrl+S)"
          disabled={file.saving || file.readOnly || !file.dirty}
          onClick={() => void handleSave()}
        >
          <Save size={14} />
        </button>
        <button type="button" className="icon-btn" title="关闭" onClick={requestClose}>
          <X size={14} />
        </button>
      </header>

      {file.readOnly ? (
        <p className="editor-notice">
          {file.relPath ? '该文件为只读（二进制、过大或无法解码）' : ''}
        </p>
      ) : null}

      <div className="editor-body">
        <FileTree group={group} activePath={file.relPath} onOpen={requestOpen} onError={onError} />
        <div className="editor-main">
          {file.relPath ? (
            <CodeMirrorHost
              value={file.content}
              filePath={file.relPath}
              readOnly={file.readOnly}
              onChange={update}
            />
          ) : (
            <p className="editor-placeholder">从左侧选择文件</p>
          )}
        </div>
      </div>

      {pendingPath ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card editor-confirm">
            <p className="confirm-message">
              「{file.relPath}」有未保存的修改，切换将丢失。是否继续？
            </p>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setPendingPath(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const next = pendingPath;
                  setPendingPath(null);
                  if (next) void open(next);
                }}
              >
                继续
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 7: 样式**

在 `src/styles.css` 的 `/* ---------- Git panel ---------- */` 之前插入：

```css
/* ---------- Editor ---------- */

.editor-pane {
  display: flex;
  flex-direction: column;
}

.editor-encoding {
  margin-left: auto;
  padding: 0 8px;
  font-size: 10.5px;
  color: var(--faint);
  letter-spacing: 0.04em;
}

.editor-notice {
  margin: 0;
  padding: 6px 12px;
  background: #fff8e6;
  border-bottom: 1px solid #f0e3bf;
  font-size: 11.5px;
  color: #8a6d1f;
}

.editor-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.file-tree {
  flex: 0 0 220px;
  min-height: 0;
  overflow: auto;
  padding: 6px 0;
  border-right: 1px solid var(--border);
  background: #fbfbfd;
}

.file-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11.5px;
  text-align: left;
}

.file-row:hover {
  background: #f1f1f5;
}

.file-row.active {
  background: #e9ecff;
  color: var(--text);
}

.file-row.is-disabled {
  opacity: 0.45;
}

.file-caret {
  flex: 0 0 12px;
  transition: transform 120ms ease;
}

.file-caret.open {
  transform: rotate(90deg);
}

.file-caret-spacer {
  flex: 0 0 12px;
}

.file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--surface);
}

.editor-placeholder {
  margin: 0;
  padding: 18px;
  font-size: 12px;
  color: var(--muted);
}

.codemirror-host {
  height: 100%;
}

.codemirror-host .cm-editor {
  height: 100%;
  font-size: 12.5px;
}

.codemirror-host .cm-scroller {
  font-family: "Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei", monospace;
  line-height: 1.5;
}

.editor-confirm {
  max-width: 420px;
}
```

- [ ] **Step 8: 验证**

Run: `npm run typecheck && npx vite build`
Expected: 均通过。检查构建输出里 CodeMirror 语言包被拆成独立 chunk（动态导入生效）。

- [ ] **Step 9: 提交**

```bash
git add package.json package-lock.json src/editorLanguage.ts src/useEditorFile.ts src/components/CodeMirrorHost.tsx src/components/FileTree.tsx src/components/EditorPane.tsx src/styles.css
git commit -m "feat(editor): add file tree, codemirror host and save flow"
```

---

### Task 5: 入口接入与端到端测试

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/GitPanel.tsx`
- Test: `tests/editor.mjs`

**Interfaces:**
- Consumes: Task 3 的 `createEditor`、Task 4 的 `EditorPane`
- Produces: `openEditorFile(group, relPath)`，供 Git 面板调用

- [ ] **Step 1: 打开指定文件**

`src/App.tsx` 的 `createEditor` 之后加入：

```tsx
  const openEditorFile = useCallback(
    (group: Group, relPath: string) => {
      const existing = (tabsRef.current[group.key] || []).find(
        (item) => item.shellId === 'editor' && item.filePath === relPath,
      );
      if (existing) {
        setActiveTabByGroup((previous) => ({ ...previous, [group.key]: existing.id }));
        setActiveGroupKey(group.key);
        return;
      }
      createEditor(group, relPath);
    },
    [createEditor],
  );
```

- [ ] **Step 2: Git 面板改用编辑器打开**

`src/components/GitPanel.tsx` 的 props 中，`onOpenDiff` 之后加入：

```ts
  onOpenInEditor: (change: GitChange) => void;
```

解构参数加入 `onOpenInEditor`。

把变更行的操作按钮从单一的「打开目录」改为两个图标。先确认当前实现——变更行是单个 `<button>` 直接 `onClick={() => onOpenDiff(change)}`。改为：

```tsx
            <li key={`${change.status}:${change.path}`} className="git-change-item">
              <button
                type="button"
                className="git-change-row"
                title={change.origPath ? `${change.origPath} → ${change.path}` : change.path}
                onClick={() => onOpenDiff(change)}
              >
                <span className={cn('git-change-badge', `is-${change.status}`)}>
                  {STATUS_LABEL[change.status]}
                </span>
                <span className="git-change-path">
                  {change.origPath ? `${change.origPath} → ${change.path}` : change.path}
                </span>
              </button>
              <button
                type="button"
                className="git-row-action"
                title="用编辑器打开"
                onClick={() => onOpenInEditor(change)}
              >
                <FileCode size={13} />
              </button>
            </li>
```

`lucide-react` import 加入 `FileCode`。

`src/styles.css` 的 Git 面板段落追加：

```css
.git-change-item {
  display: flex;
  align-items: center;
}

.git-change-item .git-change-row {
  flex: 1;
  min-width: 0;
}

.git-row-action {
  flex: 0 0 24px;
  width: 24px;
  height: 22px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--faint);
  opacity: 0;
}

.git-change-item:hover .git-row-action {
  opacity: 1;
}

.git-row-action:hover {
  background: #ebebef;
  color: var(--text);
}
```

- [ ] **Step 3: App 注入该回调**

`src/App.tsx` 的 `<GitPanel ... />` 中，`onOpenDiff` 之后加入：

```tsx
                onOpenInEditor={(change) => openEditorFile(gitGroup, change.path)}
```

- [ ] **Step 4: 写端到端测试**

创建 `tests/editor.mjs`：

```js
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const iconv = require('iconv-lite');

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-data-'));
const repo = mkdtempSync(join(tmpdir(), 'cmdtb-edit-'));

mkdirSync(join(repo, 'src'));
writeFileSync(join(repo, 'index.php'), '<?php echo 1;\n');
writeFileSync(join(repo, 'src', 'app.js'), 'console.log(1);\n');
writeFileSync(join(repo, 'gbk.txt'), iconv.encode('中文内容\n', 'gbk'));
writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3]));

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

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
await page.waitForTimeout(1000);

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

async function waitFor(predicate, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${message}`);
    await page.waitForTimeout(250);
  }
}

console.log('1. 打开编辑器页签');
await click(page.locator('.add-project-btn'));
await waitFor(async () => (await page.locator('.modal-card').count()) > 0, '添加项目弹窗');
await page.locator('#project-path').fill(repo);
await page.locator('#project-name').fill('edit-proj');
await click(page.getByRole('button', { name: '保存项目', exact: true }));
await page.locator('.modal-card').waitFor({ state: 'detached', timeout: 15000 });
await page.waitForTimeout(400);

await click(page.locator('.group-item').filter({ hasText: 'edit-proj' }).locator('.group-main'));
await page.waitForTimeout(600);
await page.locator('.group-item').filter({ hasText: 'edit-proj' }).click({ button: 'right' });
await page.locator('.popup-menu').waitFor({ timeout: 8000 });
await click(page.getByRole('menuitem', { name: '打开编辑器', exact: true }));
await waitFor(async () => (await page.locator('.editor-pane').count()) > 0, '编辑器页签出现');
assert(await page.locator('.editor-pane').isVisible(), '编辑器可见');

console.log('2. 文件树');
await waitFor(
  async () => (await page.locator('.file-row').filter({ hasText: 'index.php' }).count()) > 0,
  '文件树列出 index.php',
);
assert(
  await page.locator('.file-row').filter({ hasText: 'src' }).isVisible(),
  '文件树列出 src 目录',
);
assert(
  (await page.locator('.file-row').filter({ hasText: 'node_modules' }).count()) === 0,
  '不列出 node_modules',
);

console.log('3. 展开目录');
await click(page.locator('.file-row').filter({ hasText: 'src' }));
await waitFor(
  async () => (await page.locator('.file-row').filter({ hasText: 'app.js' }).count()) > 0,
  '展开后列出 app.js',
);

console.log('4. 打开并编辑保存');
await click(page.locator('.file-row').filter({ hasText: 'index.php' }));
await waitFor(async () => (await page.locator('.cm-content').count()) > 0, '编辑器加载');
assert(
  (await page.locator('.cm-content').innerText()).includes('echo 1'),
  '显示文件内容',
);
assert((await page.locator('.editor-encoding').innerText()) === 'UTF-8', '显示编码 UTF-8');

await page.locator('.cm-content').click();
await page.keyboard.press('Control+A');
await page.keyboard.type('<?php echo 99;\n');
await waitFor(
  async () => (await page.locator('.pane-path').innerText()).includes('•'),
  '标题出现未保存标记',
);
await page.keyboard.press('Control+S');
await waitFor(
  async () => !(await page.locator('.pane-path').innerText()).includes('•'),
  '保存后未保存标记消失',
);
assert(readFileSync(join(repo, 'index.php'), 'utf8') === '<?php echo 99;\n', '磁盘内容已更新');

console.log('5. GBK 文件保存后编码不变');
await click(page.locator('.file-row').filter({ hasText: 'gbk.txt' }));
await waitFor(async () => (await page.locator('.cm-content').count()) > 0, 'GBK 文件加载');
assert((await page.locator('.editor-encoding').innerText()) === 'GBK', '识别 GBK');
assert((await page.locator('.cm-content').innerText()).includes('中文内容'), 'GBK 中文正常显示');
await page.locator('.cm-content').click();
await page.keyboard.press('Control+A');
await page.keyboard.type('新的内容\n');
await page.keyboard.press('Control+S');
await page.waitForTimeout(1200);
const gbkAfter = readFileSync(join(repo, 'gbk.txt'));
assert(Buffer.compare(gbkAfter, iconv.encode('新的内容\n', 'gbk')) === 0, 'GBK 原样写回');

console.log('6. 二进制只读');
await click(page.locator('.file-row').filter({ hasText: 'bin.dat' }));
await waitFor(async () => (await page.locator('.editor-notice').count()) > 0, '只读提示出现');
assert(
  await page.getByRole('button', { name: '保存 (Ctrl+S)' }).isDisabled(),
  '只读文件保存按钮禁用',
);

console.log('7. Git 面板用编辑器打开');
writeFileSync(join(repo, 'index.php'), '<?php echo 100;\n');
await page.waitForTimeout(1500);
await click(page.locator('.git-icon-btn'));
await waitFor(
  async () => (await page.locator('.git-change-row').filter({ hasText: 'index.php' }).count()) > 0,
  'Git 面板列出变更',
);
const beforeTabs = await page.locator('.tab').count();
await click(
  page
    .locator('.git-change-item')
    .filter({ hasText: 'index.php' })
    .locator('.git-row-action'),
);
await waitFor(
  async () => (await page.locator('.tab').count()) === beforeTabs + 1,
  '新开编辑器页签',
);

await app.close();
rmSync(dataDir, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 5: 运行测试**

Run: `npm run typecheck && npx vite build && node tests/editor.mjs`
Expected: 全部通过

（若端口被占用导致启动超时，按 Task 2 Step 2 的隔离副本办法处理。）

- [ ] **Step 6: 回归**

Run: `node tests/git-panel.mjs`
Run: `node tests/git-core.mjs`
Run: `node tests/file-api.mjs`
Expected: 全部通过

- [ ] **Step 7: 提交**

```bash
git add src/App.tsx src/components/GitPanel.tsx src/styles.css tests/editor.mjs
git commit -m "feat(editor): open files from git panel and add e2e coverage"
```

---

## 计划自检

**规格覆盖**

| 规格条目 | 对应任务 |
|---|---|
| editor 页签类型 | Task 3 |
| 左文件树、右编辑器 | Task 4 |
| 按需加载文件树 | Task 4 `FileTree.loadDir` |
| 忽略 node_modules 等 | Task 1 `IGNORED` |
| CodeMirror + 语言高亮 | Task 4 |
| 手动保存 Ctrl+S | Task 4 `handleSave` |
| 未保存标记与关闭确认 | Task 4 |
| 编码识别与保持 | Task 1 + Task 4 |
| 大文件与二进制只读 | Task 1 |
| mtime 外部修改检测 | Task 1 `write` |
| 路径安全 | Task 1 `path-guard` |
| 三个打开入口 | Task 3（右键菜单）、Task 5（Git 面板）、Task 4（文件树） |
| 会话持久化 | Task 3 |
| 端到端测试 | Task 5 |

**已知偏离规格之处**

- 规格提到「其他程序修改后提供『重新加载』按钮」。本计划改为：保存时检测到 mtime 冲突则 toast 报错，用户重新点击该文件即从磁盘重新加载。少一个按钮，行为等价。
- 规格要求符号链接禁用点击，实现为 `entry.isSymlink` 时按钮 `disabled`。

**类型一致性**

`OpenedFile` 在 Task 2 定义（`src/types.ts`），Task 4 的 `useEditorFile` 消费；`FileEntry` 在 Task 2 定义，Task 4 的 `FileTree` 消费；`Tab.filePath` 在 Task 3 定义，Task 4/5 消费。`fileApi.write` 的五个参数在 Task 1、2、4 中一致。
