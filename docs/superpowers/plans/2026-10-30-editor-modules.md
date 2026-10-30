# 编辑器模块系统 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Cmd Toolbox 的编辑器加一套内置模块系统，提供代码格式化、JS 压缩、JS/TS 与 PHP 语法诊断，能力对标 VS Code 对应扩展。

**Architecture:** 模块清单写死在 `src/modules/catalog.ts`，每个模块按需动态 `import()` 自己的实现，全部在渲染进程执行。用户开关存进现有 `AppPrefs.enabledModules`。诊断走 CodeMirror `linter()` + 新 `Compartment`；格式化/压缩是命令，走编辑器右键菜单与快捷键。压缩的自动触发条件是「同名 `.min.js` 已存在」，与设置开关无关。

**Tech Stack:** React 19 + TypeScript + CodeMirror 6 + Vite + Electron 45。新增依赖：`prettier`、`terser`、`acorn`、`php-parser`、`@codemirror/lint`。

## Global Constraints

- **设置页签顺序固定为「关于 / 常规 / 终端 / 编辑器 / 快捷键」，「关于」必须第一位**，`tests/update-notify.mjs` 有断言。新页签「模块」插在「编辑器」之后、「快捷键」之前，插入后必须同步更新 `CLAUDE.md` 里那段注释。
- **IPC 四处都要改**：`desktop/main.js` 的 `ipcMain.handle`、`desktop/preload.js` 的 `invoke()` 包装、`src/global.d.ts` 类型声明、调用方。缺一处就是运行时错误或类型报错。
- **渲染进程依赖放 `devDependencies`**。只有主进程运行时用到的包（`electron-updater` / `iconv-lite` / `node-pty`）才放 `dependencies`。这些模块全在前端 bundle 里，vite 打包时会被剥离。
- **改了 `src/` 之后先重建再跑 GUI 测试**：`npx tsc --noEmit && npx vite build`。**不要用 `npm run build`**，它会重编译 `build/coninject.exe` 把被跟踪的二进制改脏。
- **UI 测试必须独占 17382 端口**，跑之前先关掉运行中的 Cmd Toolbox，否则 `firstWindow: Timeout 30000ms exceeded`。
- **提交信息不加任何 AI 署名**（不加 `Co-Authored-By: Claude` 之类）。
- **压缩失败绝不能导致保存失败。**
- **`files.write()` 无法创建新文件**（第一行 `fsp.stat` 会抛错），新建 `.min.js` 必须走新通道。

---

## 文件结构

**新建**

| 文件 | 职责 |
|---|---|
| `src/modules/catalog.ts` | 模块清单常量、类型定义、按 id 查找 |
| `src/modules/format.ts` | prettier 封装，暴露 `format(text, lang)` |
| `src/modules/minify.ts` | terser 封装，暴露 `minify(text)` 与 `minifiedName(relPath)` |
| `src/modules/diagnose-js.ts` | acorn 封装，暴露 `diagnoseJs(text, lang)` |
| `src/modules/diagnose-php.ts` | php-parser 封装，暴露 `diagnosePhp(text)` |
| `src/modules/registry.ts` | 按 `EditorModule` 懒加载并分发到上面四个实现 |
| `src/components/EditorContextMenu.ts` | 编辑器右键菜单项构造，复用 `PopupMenu` |
| `tests/editor-modules.mjs` | Playwright 端到端 |
| `tests/module-catalog.mjs` | 离线：清单合法性与偏好迁移 |

**修改**

| 文件 | 改动 |
|---|---|
| `src/prefs.ts` | `AppPrefs.enabledModules` 字段、默认值、读取时丢弃未知 id |
| `src/global.d.ts` | `files.stat`、`files.writeMinified` 类型 |
| `desktop/file-api.js` | 新增 `stat()`、`writeMinified()` |
| `desktop/main.js` | 注册 `fs:stat`、`fs:write-minified` |
| `desktop/preload.js` | 包装两条新通道 |
| `src/useEditorFiles.ts` | 保存钩子调压缩，**插在 `if (!current.dirty) return false;` 之前** |
| `src/components/CodeMirrorHost.tsx` | 新增 `diagnosticsRef` Compartment、右键菜单绑定 |
| `src/components/EditorPane.tsx` | 透传 `prefs` 与模块回调 |
| `src/components/SettingsModal.tsx` | 新增「模块」页签与开关列表 |
| `src/editorKeymap.ts` | 新增 `formatDocument` 动作，默认 `Shift-Alt-F` |
| `src/styles.css` | 模块列表样式（尽量复用 `.settings-item`） |
| `CLAUDE.md` | 页签顺序注释、模块系统约定 |

---

## Task 1: 模块清单与偏好字段

**Files:**
- Create: `src/modules/catalog.ts`
- Modify: `src/prefs.ts:6-20`（`AppPrefs` 类型）、`src/prefs.ts:39-55`（`defaultPrefs`）、`src/prefs.ts:75-122`（`readPrefs`）
- Test: `tests/module-catalog.mjs`

**Interfaces:**
- Produces:
  - `type ModuleKind = 'format' | 'minify' | 'diagnostics'`
  - `type EditorModule = { id: string; name: string; description: string; kind: ModuleKind; languages: string[]; requires?: 'download' }`
  - `const EDITOR_MODULES: EditorModule[]`
  - `const DEFAULT_ENABLED_MODULES: string[]`
  - `function findModule(id: string): EditorModule | undefined`
  - `function modulesFor(kind: ModuleKind, lang: string): EditorModule[]`
  - `AppPrefs.enabledModules: string[]`

- [ ] **Step 1: 写失败的测试**

创建 `tests/module-catalog.mjs`：

```js
// 模块清单的离线校验：不需要 Electron 或 GUI。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

// catalog 是纯 TS 常量，这里用正则读源码，避免引入打包链路
const source = readFileSync(resolve(root, 'src/modules/catalog.ts'), 'utf8');

console.log('1. 清单里的模块定义完整');
const ids = [...source.matchAll(/^\s+id: '([^']+)'/gm)].map((m) => m[1]);
assert(ids.length === 4, `有 4 个模块，实际 ${ids.length}`);
assert(new Set(ids).size === 4, 'id 互不重复');

console.log('2. 每个模块的 kind 合法');
const kinds = [...source.matchAll(/^\s+kind: '([^']+)'/gm)].map((m) => m[1]);
for (const kind of kinds) {
  assert(['format', 'minify', 'diagnostics'].includes(kind), `kind ${kind} 合法`);
}

console.log('3. 每个模块都声明了语言');
const langs = [...source.matchAll(/^\s+languages: \[([^\]]+)\]/gm)];
assert(langs.length === 4, `4 个模块都声明了 languages，实际 ${langs.length}`);
for (const match of langs) {
  assert(match[1].trim().length > 0, 'languages 非空');
}

console.log('4. 默认不启用诊断模块');
const defaults = source.match(/DEFAULT_ENABLED_MODULES[^=]*=\s*\[([^\]]*)\]/);
assert(Boolean(defaults), '找到 DEFAULT_ENABLED_MODULES');
assert(!/diag-js/.test(defaults[1]), '默认不启用 JS 诊断');
assert(/diag-php/.test(defaults[1]), '默认启用 PHP 诊断');

console.log(`\n全部通过（${passed} 项）`);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/module-catalog.mjs`
Expected: FAIL，`ENOENT` 找不到 `src/modules/catalog.ts`

- [ ] **Step 3: 创建 catalog.ts**

```ts
export type ModuleKind = 'format' | 'minify' | 'diagnostics';

export type EditorModule = {
  id: string;
  name: string;
  description: string;
  kind: ModuleKind;
  languages: string[];
  // 首版所有模块都内置在安装包里，这个字段为将来的下载制模块预留
  requires?: 'download';
};

export const EDITOR_MODULES: EditorModule[] = [
  {
    id: 'format',
    name: '代码格式化',
    description: '支持 JS / TS / HTML / CSS / JSON / Markdown',
    kind: 'format',
    languages: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'html', 'htm', 'css', 'md', 'markdown'],
  },
  {
    id: 'minify',
    name: '代码压缩',
    description: '支持 JS；已有同名 .min.js 时保存自动更新',
    kind: 'minify',
    languages: ['js'],
  },
  {
    id: 'diag-js',
    name: 'JS / TS 语法检查',
    description: '在编辑器里用波浪线标出语法错误',
    kind: 'diagnostics',
    languages: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'],
  },
  {
    id: 'diag-php',
    name: 'PHP 语法检查',
    description: '基于纯 JS 解析器，不需要安装 PHP',
    kind: 'diagnostics',
    languages: ['php'],
  },
];

export const DEFAULT_ENABLED_MODULES = ['format', 'minify', 'diag-php'];

export function findModule(id: string): EditorModule | undefined {
  return EDITOR_MODULES.find((item) => item.id === id);
}

export function modulesFor(kind: ModuleKind, lang: string): EditorModule[] {
  return EDITOR_MODULES.filter(
    (item) => item.kind === kind && item.languages.includes(lang),
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/module-catalog.mjs`
Expected: PASS，全部通过（约 15 项）

- [ ] **Step 5: 给 AppPrefs 加字段**

`src/prefs.ts`，在 `AppPrefs` 类型里加：

```ts
  enabledModules: string[];
```

`defaultPrefs()` 里加（注意 `DEFAULT_ENABLED_MODULES` 要 import）：

```ts
import { DEFAULT_ENABLED_MODULES, findModule } from './modules/catalog';
```

```ts
    enabledModules: [...DEFAULT_ENABLED_MODULES],
```

`readPrefs()` 的 return 里加（未知 id 丢弃，防止降级后残留脏数据）：

```ts
      enabledModules: (Array.isArray(parsed.enabledModules)
        ? parsed.enabledModules
        : DEFAULT_ENABLED_MODULES
      ).filter((id): id is string => typeof id === 'string' && Boolean(findModule(id))),
```

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出（通过）

- [ ] **Step 7: 提交**

```bash
git add src/modules/catalog.ts src/prefs.ts tests/module-catalog.mjs
git commit -m "feat(modules): 模块清单与 enabledModules 偏好字段"
```

---

## Task 2: 新增 files.stat 与 files.writeMinified 两个 IPC

**Files:**
- Modify: `desktop/file-api.js:138-156`（在 `write` 后面加两个函数）、`desktop/file-api.js:232`（导出）
- Modify: `desktop/main.js:391-397`（在 `fs:write` 后加两个 handler）
- Modify: `desktop/preload.js:109-116`
- Modify: `src/global.d.ts:192-202`

**Interfaces:**
- Produces（渲染进程侧）：
  - `window.api.files.stat(projectPath: string, relPath: string): Promise<{ exists: boolean; mtime: number }>`
  - `window.api.files.writeMinified(projectPath: string, relPath: string, content: string): Promise<{ ok: true }>`

- [ ] **Step 1: 在 file-api.js 加实现**

在 `write()` 函数之后（约 156 行）插入：

```js
// 「文件不存在」是正常结果而不是异常，所以不抛错。
// 自动压缩要靠它判断同名 .min.js 在不在。
async function stat(projectPath, relPath) {
  const target = resolveWithin(projectPath, relPath);
  try {
    const info = await fsp.stat(target);
    return { exists: info.isFile(), mtime: info.mtimeMs };
  } catch {
    return { exists: false, mtime: 0 };
  }
}

// 压缩产物专用：允许创建新文件，不做 mtime 校验。
// 产物没有并发编辑的顾虑，现有 write() 因为先 stat 所以无法建新文件。
async function writeMinified(projectPath, relPath, content) {
  const target = resolveWithin(projectPath, relPath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temp, String(content ?? ''), 'utf8');
  await fsp.rename(temp, target);
  return { ok: true };
}
```

把导出行改成：

```js
module.exports = { list, read, write, stat, writeMinified, detectEncoding, search };
```

- [ ] **Step 2: 注册 IPC handler**

`desktop/main.js`，在 `fs:write` 那行之后加：

```js
  ipcMain.handle('fs:stat', (_event, projectPath, relPath) =>
    fileApi.stat(projectPath, relPath),
  );
  ipcMain.handle('fs:write-minified', (_event, projectPath, relPath, content) =>
    fileApi.writeMinified(projectPath, relPath, content),
  );
```

（若 `main.js` 里 `file-api` 的引入别名不是 `fileApi`，按现有写法对齐。）

- [ ] **Step 3: preload 包装**

`desktop/preload.js` 的 `files:` 对象里加：

```js
    stat: (projectPath, relPath) => invoke('fs:stat', projectPath, relPath),
    writeMinified: (projectPath, relPath, content) =>
      invoke('fs:write-minified', projectPath, relPath, content),
```

- [ ] **Step 4: 类型声明**

`src/global.d.ts` 的 `files:` 里加：

```ts
        stat: (
          projectPath: string,
          relPath: string,
        ) => Promise<{ exists: boolean; mtime: number }>;
        writeMinified: (
          projectPath: string,
          relPath: string,
          content: string,
        ) => Promise<{ ok: true }>;
```

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出

- [ ] **Step 6: 提交**

```bash
git add desktop/file-api.js desktop/main.js desktop/preload.js src/global.d.ts
git commit -m "feat(files): 新增 stat 与 writeMinified 通道

writeMinified 允许创建新文件，供压缩产物使用；
stat 用于判断同名 .min.js 是否存在。"
```

---

## Task 3: 格式化模块 + 编辑器右键菜单 + 快捷键

**Files:**
- Create: `src/modules/format.ts`
- Create: `src/modules/registry.ts`
- Create: `src/components/EditorContextMenu.ts`
- Modify: `src/editorKeymap.ts`（新增 `formatDocument` 动作）
- Modify: `src/components/CodeMirrorHost.tsx`（右键绑定、快捷键接线）
- Modify: `src/components/EditorPane.tsx`（透传 props）
- Test: `tests/editor-modules.mjs`

**Interfaces:**
- Consumes: `findModule` / `modulesFor` / `EditorModule`（Task 1）、`prefs.enabledModules`（Task 1）
- Produces:
  - `src/modules/format.ts` → `format(text: string, lang: string): Promise<string>`
  - `src/modules/registry.ts` → `runFormat(module, text, lang)`、`runMinify(module, text, lang)`、`runDiagnose(module, text, lang)`、`type Diagnostic`
  - `src/components/EditorContextMenu.ts` → `type EditorModuleActions`、`buildEditorMenu(actions): MenuEntry[]`

- [ ] **Step 1: 安装依赖**

```bash
npm install --save-dev prettier terser acorn php-parser @codemirror/lint
```

- [ ] **Step 2: 写 format.ts**

```ts
// prettier 的 standalone 版本不带任何语言，插件必须显式引入。
// 用动态 import 是为了让每个语言插件各自成 chunk，不打进首屏。
export async function format(text: string, lang: string): Promise<string> {
  const [{ format: prettierFormat }] = await Promise.all([
    import('prettier/standalone'),
    loadParser(lang),
  ]);
  const parser = parserName(lang);
  if (!parser) throw new Error(`不支持格式化该语言：${lang}`);
  return prettierFormat(text, { parser, printWidth: 100 });
}

function parserName(lang: string): string | null {
  if (['js', 'mjs', 'cjs', 'jsx'].includes(lang)) return 'babel';
  if (['ts', 'tsx'].includes(lang)) return 'typescript';
  if (lang === 'json') return 'json';
  if (lang === 'html' || lang === 'htm') return 'html';
  if (lang === 'css') return 'css';
  if (lang === 'md' || lang === 'markdown') return 'markdown';
  return null;
}

async function loadParser(lang: string): Promise<unknown> {
  if (['js', 'mjs', 'cjs', 'jsx'].includes(lang)) await import('prettier/plugins/babel');
  if (['ts', 'tsx'].includes(lang)) await import('prettier/plugins/typescript');
  if (lang === 'json') await import('prettier/plugins/babel');
  if (lang === 'html' || lang === 'htm') await import('prettier/plugins/html');
  if (lang === 'css') await import('prettier/plugins/postcss');
  if (lang === 'md' || lang === 'markdown') await import('prettier/plugins/markdown');
  return null;
}
```

- [ ] **Step 3: 写 registry.ts**

```ts
import type { EditorModule } from './catalog';

export type Diagnostic = {
  from: number;
  to: number;
  severity: 'error' | 'warning';
  message: string;
};

export async function runFormat(module: EditorModule, text: string, lang: string) {
  const impl = await import('./format');
  return impl.format(text, lang);
}

export async function runMinify(module: EditorModule, text: string, lang: string) {
  const impl = await import('./minify');
  return impl.minify(text, lang);
}

export async function runDiagnose(
  module: EditorModule,
  text: string,
  lang: string,
): Promise<Diagnostic[]> {
  if (module.id === 'diag-php') {
    const impl = await import('./diagnose-php');
    return impl.diagnosePhp(text);
  }
  const impl = await import('./diagnose-js');
  return impl.diagnoseJs(text, lang);
}
```

- [ ] **Step 4: 写 EditorContextMenu.ts**

```ts
import type { MenuEntry } from '../types';

export type EditorModuleActions = {
  format: () => void;
  formatSelection: () => void;
  canFormat: boolean;
  hasSelection: boolean;
  minify: (() => void) | null;
  minifyLabel: string;
};

export function buildEditorMenu(actions: EditorModuleActions): MenuEntry[] {
  const items: MenuEntry[] = [];
  if (actions.canFormat) {
    items.push({
      type: 'item',
      id: 'editor-format',
      label: '格式化文档',
      shortcut: 'Shift+Alt+F',
      disabled: !actions.canFormat,
      onSelect: actions.format,
    });
    items.push({
      type: 'item',
      id: 'editor-format-selection',
      label: '格式化选区',
      disabled: !actions.hasSelection,
      onSelect: actions.formatSelection,
    });
  }
  if (actions.minify) {
    if (items.length) items.push({ type: 'separator', id: 'editor-menu-sep-1' });
    items.push({
      type: 'item',
      id: 'editor-minify',
      label: actions.minifyLabel,
      onSelect: actions.minify,
    });
  }
  return items;
}
```

- [ ] **Step 5: 写失败的 UI 测试骨架**

创建 `tests/editor-modules.mjs`，先只覆盖格式化：

```js
// 编辑器模块的端到端测试。
// 需要独占 17382 端口，跑之前先关掉正在运行的 Cmd Toolbox。
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'cmdtb-modules-'));
const projectDir = mkdtempSync(join(tmpdir(), 'cmdtb-proj-'));

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

  await page.locator('.add-project-btn').click();
  await page.locator('.modal-card').waitFor();
  await page.locator('#project-path').fill(projectDir);
  await page.locator('#project-name').fill('mod-proj');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await page.locator('.modal-card').waitFor({ state: 'detached' });
  await page.waitForTimeout(400);
  await page.locator('.group-main', { hasText: 'mod-proj' }).click();
  await page.waitForTimeout(400);

  console.log('1. 设置面板出现「模块」页签');
  await page.locator('.titlebar-settings, [aria-label="设置"]').first().click();
  await page.locator('.settings-tabs').waitFor();
  const tabs = await page.locator('.settings-tab').allInnerTexts();
  assert(tabs.includes('模块'), `页签里有「模块」，实际 ${tabs.join('/')}`);
  const editorIdx = tabs.indexOf('编辑器');
  assert(
    tabs.indexOf('模块') === editorIdx + 1,
    `「模块」紧跟在「编辑器」之后，实际顺序 ${tabs.join('/')}`,
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  console.log('2. 格式化：乱排版被整理，且可撤销');
  const messy = 'const a={x:1,y:2};\nfunction f(){if(!a.x){return 1}return 2}\n';
  writeFileSync(join(projectDir, 'sample.js'), messy, 'utf8');
  await openFile(page, 'sample.js');
  const before = await editorText(page);
  assert(before.includes('const a={x:1,y:2}'), '打开的是未格式化的原文');
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Shift+Alt+f');
  await page.waitForTimeout(1200);
  const after = await editorText(page);
  assert(after.includes('const a = { x: 1, y: 2 };'), '格式化后加了空格');
  assert(after.split('\n').length > 5, `格式化后行数变多，实际 ${after.split('\n').length}`);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  assert(
    (await editorText(page)) === before,
    'Ctrl+Z 能撤销格式化',
  );

  console.log(`\n全部通过（${passed} 项）`);
} finally {
  await app.close().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

// 打开文件树里的文件。文件树的选择器以实际 DOM 为准，
// 若 `.file-tree` 未展开，先点侧栏的折叠区标题展开。
async function openFile(page, name) {
  const entry = page.locator('.file-tree').getByText(name, { exact: true });
  await entry.waitFor({ timeout: 10000 });
  await entry.click();
  await page.locator('.cm-content').first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(600);
}

// 读编辑器全文：CodeMirror 的内容不在 textarea 里，只能从 DOM 取
async function editorText(page) {
  return page.locator('.cm-content').first().innerText();
}
```

> 注：`openFile` 依赖文件树已经展开到项目根目录。若首次运行时 `.file-tree` 不可见，需在 `openFile` 前补一次展开操作——以实际 DOM 为准。

- [ ] **Step 6: 运行测试确认失败**

先关掉运行中的 Cmd Toolbox，再：

Run: `node tests/editor-modules.mjs`
Expected: FAIL，`.settings-tab` 里没有「模块」

- [ ] **Step 7: 在 CodeMirrorHost 接格式化**

`src/components/CodeMirrorHost.tsx`：

1. props 加 `lang: string`、`canFormat: boolean`、`onRequestMenu: (event: ReactMouseEvent) => void`
2. 在 `displayRef` 之后加 `const formatRef = useRef(new Compartment());`
3. 在 `EditorView` 创建处加进 extensions 数组：

```ts
          formatRef.current.of(
            canFormat
              ? keymap.of([
                  {
                    key: 'Shift-Alt-f',
                    run: (view) => {
                      void applyFormat(view, lang);
                      return true;
                    },
                  },
                ])
              : [],
          ),
```

4. 文件底部加格式化工具函数：

```ts
async function applyFormat(view: EditorView, lang: string) {
  const { format } = await import('../modules/format');
  const target = view.state.sliceDoc();
  const next = await format(target, lang);
  if (next === target) return;
  view.dispatch({ changes: { from: 0, to: target.length, insert: next } });
}
```

5. 给编辑器容器加右键绑定：

```tsx
<div className="cm-host" ref={hostRef} onContextMenu={(event) => onRequestMenu(event)} />
```

> 实际容器 class 以现有渲染结果为准，可能是 `hostRef` 对应的最外层 div。

- [ ] **Step 8: EditorPane 透传**

`EditorPane.tsx` 里把 `lang`（从 `filePath` 后缀取）、`canFormat`（模块启用且语言支持）、`onRequestMenu` 传给 `CodeMirrorHost`。`onRequestMenu` 用现有 `PopupMenu` 渲染：

```tsx
const [menu, setMenu] = useState<MenuState | null>(null);
```

菜单项由 `buildEditorMenu` 生成，`onSelect` 里调用与快捷键相同的 `applyFormat`。

- [ ] **Step 9: 注册 formatDocument 动作**

`src/editorKeymap.ts` 的 `EditorActionId` 加 `'formatDocument'`，`DEFAULT_KEYBINDINGS` 加：

```ts
  formatDocument: 'Shift-Alt-F',
```

- [ ] **Step 10: 运行测试确认通过**

Run: `npx tsc --noEmit && npx vite build && node tests/editor-modules.mjs`
Expected: PASS，两项断言通过

- [ ] **Step 11: 提交**

```bash
git add src/modules src/components/EditorContextMenu.ts src/components/CodeMirrorHost.tsx src/components/EditorPane.tsx src/editorKeymap.ts tests/editor-modules.mjs package.json package-lock.json
git commit -m "feat(editor): 代码格式化，右键菜单与 Shift+Alt+F"
```

---

## Task 4: 压缩模块与保存钩子

**Files:**
- Create: `src/modules/minify.ts`
- Modify: `src/useEditorFiles.ts:149-160`（在 `dirty` 早退之前插钩子）
- Modify: `src/components/EditorContextMenu.ts`（加压缩项）
- Test: `tests/editor-modules.mjs`（追加用例）

**Interfaces:**
- Consumes: `window.api.files.stat` / `writeMinified`（Task 2）、`findModule('minify')`（Task 1）
- Produces:
  - `minify(text: string, lang: string): Promise<string>`
  - `minifiedName(relPath: string): string`
  - `shouldAutoMinify(projectPath: string, relPath: string): Promise<boolean>`

- [ ] **Step 1: 写 minify.ts**

```ts
export function minifiedName(relPath: string): string {
  const dot = relPath.lastIndexOf('.');
  if (dot < 0) return `${relPath}.min.js`;
  return `${relPath.slice(0, dot)}.min${relPath.slice(dot)}`;
}

export async function minify(text: string): Promise<string> {
  const { minify: terserMinify } = await import('terser');
  const result = await terserMinify(text, { compress: true, mangle: true });
  if (result.error) throw result.error;
  if (typeof result.code !== 'string') throw new Error('压缩没有返回内容');
  return result.code;
}

export async function shouldAutoMinify(
  stat: (relPath: string) => Promise<{ exists: boolean }>,
  relPath: string,
): Promise<boolean> {
  // 只有 .js 参与；.min.js 自己不再压
  if (!relPath.endsWith('.js') || relPath.endsWith('.min.js')) return false;
  const result = await stat(minifiedName(relPath));
  return result.exists;
}
```

- [ ] **Step 2: 写失败的测试**

在 `tests/editor-modules.mjs` 的断言区追加：

```js
  console.log('3. 压缩：同名 .min.js 不存在时不会创建');
  writeFileSync(join(projectDir, 'plain.js'), 'const x = 1;\nfunction f(){return x}\n', 'utf8');
  // 打开并保存 plain.js（下面用真实 UI 操作）
  // ... 打开文件、Ctrl+S ...
  await page.waitForTimeout(800);
  assert(
    !existsSync(join(projectDir, 'plain.min.js')),
    '没有 .min.js 时保存不创建它',
  );

  console.log('4. 压缩：同名 .min.js 存在时自动更新');
  writeFileSync(join(projectDir, 'withmin.js'), 'const y = 1;\n', 'utf8');
  writeFileSync(join(projectDir, 'withmin.min.js'), '/*old*/', 'utf8');
  // ... 打开 withmin.js、编辑、Ctrl+S ...
  await page.waitForTimeout(1200);
  const minified = readFileSync(join(projectDir, 'withmin.min.js'), 'utf8');
  assert(!minified.includes('/*old*/'), '已有 .min.js 被覆盖更新');
  assert(minified.length < 40, `压缩结果很短，实际长度 ${minified.length}`);
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node tests/editor-modules.mjs`
Expected: FAIL，`compressed.min.js` 不存在（因为还没实现）

- [ ] **Step 4: 在 useEditorFiles 插入保存钩子**

`src/useEditorFiles.ts`，**必须插在 `if (!current.dirty) return false;` 之前**：

```ts
      // 自动压缩必须在「内容没变就返回」之前：用户要求不管有没有修改都执行。
      // 判定依据是「同名 .min.js 是否存在」，不是设置开关——不存在就绝不创建。
      void (async () => {
        try {
          if (!relPath.endsWith('.js') || relPath.endsWith('.min.js')) return;
          const projectPath = groupRef.current.path;
          const target = minifiedName(relPath);
          const info = await window.api.files.stat(projectPath, target);
          if (!info.exists) return;
          const compressed = await minify(current.content);
          await window.api.files.writeMinified(projectPath, target, compressed);
        } catch (error) {
          onError(`压缩为 ${minifiedName(relPath)} 失败：${toErrorMessage(error)}`);
        }
      })();
```

import：

```ts
import { minifiedName, minify } from './modules/minify';
```

> 注意 `onError` 是现有解构出来的回调。压缩失败只提示，不 `throw`，保证保存流程继续。

- [ ] **Step 5: 菜单加压缩项**

`EditorContextMenu.ts` 里，`buildEditorMenu` 已支持 `minify`/`minifyLabel`。在 `EditorPane` 构造 actions 时按状态算 label：

```ts
    const target = minifiedName(filePath);
    const info = await window.api.files.stat(group.path, target);
    const label = !info.exists
      ? `压缩为 ${target.split('/').pop()}`
      : sourceMtime > info.mtime
        ? `压缩为 ${target.split('/').pop()}（已过期）`
        : `压缩为 ${target.split('/').pop()}（覆盖）`;
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx tsc --noEmit && npx vite build && node tests/editor-modules.mjs`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/modules/minify.ts src/useEditorFiles.ts src/components/EditorContextMenu.ts src/components/EditorPane.tsx tests/editor-modules.mjs
git commit -m "feat(editor): JS 压缩，保存时按 .min.js 是否存在自动更新"
```

---

## Task 5: 语法诊断

**Files:**
- Create: `src/modules/diagnose-js.ts`
- Create: `src/modules/diagnose-php.ts`
- Modify: `src/components/CodeMirrorHost.tsx`（新增 `diagnosticsRef`）
- Test: `tests/editor-modules.mjs`（追加用例）

**Interfaces:**
- Produces:
  - `diagnoseJs(text: string, lang: string): Promise<Diagnostic[]>`
  - `diagnosePhp(text: string): Promise<Diagnostic[]>`

- [ ] **Step 1: 写 diagnose-js.ts**

```ts
import type { Diagnostic } from './registry';

export async function diagnoseJs(text: string, lang: string): Promise<Diagnostic[]> {
  const { parse } = await import('acorn');
  try {
    parse(text, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
      allowHashBang: true,
    });
    return [];
  } catch (error) {
    const err = error as { message?: string; pos?: number; loc?: { line: number; column: number } };
    const from = typeof err.pos === 'number' ? err.pos : 0;
    return [
      {
        from,
        to: Math.min(text.length, from + 1),
        severity: 'error',
        message: err.message || '语法错误',
      },
    ];
  }
}
```

> TS 语法 acorn 解析不了，`ts`/`tsx` 会误报。因此 CodeMirrorHost 里只在 `lang` 属于 js 系时才挂 linter，TS 走另一个分支（见 Step 3）。

- [ ] **Step 2: 写 diagnose-php.ts**

```ts
import type { Diagnostic } from './registry';

export async function diagnosePhp(text: string): Promise<Diagnostic[]> {
  const { default: parser } = await import('php-parser');
  const engine = new parser.Engine({
    parser: { extractDoc: false, suppressErrors: true },
    ast: { withPositions: true },
  });
  try {
    engine.parseCode(text, 'input.php');
    return [];
  } catch (error) {
    const err = error as { message?: string; lineNumber?: number };
    const line = Math.max(1, Number(err.lineNumber) || 1);
    const offset = offsetOfLine(text, line);
    return [
      {
        from: offset,
        to: Math.min(text.length, offset + 1),
        severity: 'error',
        message: err.message || 'PHP 语法错误',
      },
    ];
  }
}

function offsetOfLine(text: string, line: number): number {
  let offset = 0;
  for (let index = 1; index < line; index += 1) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return offset;
}
```

- [ ] **Step 3: CodeMirrorHost 挂 linter**

在 `displayRef` 后加：

```ts
  const diagnosticsRef = useRef(new Compartment());
```

extensions 数组里加：

```ts
          diagnosticsRef.current.of([]),
```

在现有 reconfigure effect 之后，加一个独立的 effect（文件顶部 import）：

```ts
import { linter } from '@codemirror/lint';
```

```ts
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const enabled = prefs.enabledModules.includes('diag-php')
      ? findModule('diag-php')
      : undefined;
    const jsModule = prefs.enabledModules.includes('diag-js')
      ? findModule('diag-js')
      : undefined;
    const lang = filePath.split('.').pop()?.toLowerCase() || '';
    const module =
      lang === 'php' && enabled
        ? enabled
        : jsModule && ['js', 'mjs', 'cjs', 'jsx'].includes(lang)
          ? jsModule
          : undefined;
    if (!module) {
      view.dispatch({ effects: diagnosticsRef.current.reconfigure([]) });
      return;
    }
    const extension = linter(
      async (target) => {
        const { runDiagnose } = await import('../modules/registry');
        const found = await runDiagnose(module, target.state.sliceDoc(), lang);
        return found.map((item) => ({
          from: Math.min(item.from, target.state.doc.length),
          to: Math.min(item.to, target.state.doc.length),
          severity: item.severity,
          message: item.message,
        }));
      },
      { delay: 500 },
    );
    view.dispatch({ effects: diagnosticsRef.current.reconfigure(extension) });
  }, [filePath, prefs.enabledModules]);
```

> `ts`/`tsx` 故意不挂 acorn，避免把类型注解当成语法错误。

- [ ] **Step 4: 追加测试**

```js
  console.log('5. 诊断：默认不开 JS 诊断，开启后出现波浪线');
  writeFileSync(join(projectDir, 'bad.js'), 'const = ;\n', 'utf8');
  // ... 打开 bad.js，断言没有 .cm-lint-marker ...
  // ... 设置里打开「JS / TS 语法检查」，断言出现 .cm-lint-marker ...
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx tsc --noEmit && npx vite build && node tests/editor-modules.mjs`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/modules/diagnose-js.ts src/modules/diagnose-php.ts src/components/CodeMirrorHost.tsx tests/editor-modules.mjs
git commit -m "feat(editor): JS/TS 与 PHP 语法诊断"
```

---

## Task 6: 设置界面「模块」页签

**Files:**
- Modify: `src/components/SettingsModal.tsx:48-56`（`TabId` 与 `ALL_TABS`）
- Modify: `src/components/SettingsModal.tsx`（渲染函数里加模块列表）
- Modify: `src/styles.css`（模块行样式，优先复用 `.settings-item`）
- Modify: `CLAUDE.md`（页签顺序注释）
- Test: `tests/editor-modules.mjs`（Task 3 已含页签断言）

**Interfaces:**
- Consumes: `EDITOR_MODULES` / `findModule`（Task 1）、`AppPrefs.enabledModules`

- [ ] **Step 1: 加页签**

```ts
type TabId = 'about' | 'regular' | 'terminal' | 'editor' | 'modules' | 'keys';
```

```ts
const ALL_TABS: { id: TabId; label: string; icon: typeof Info }[] = [
  { id: 'about', label: '关于', icon: Info },
  { id: 'regular', label: '常规', icon: Power },
  { id: 'terminal', label: '终端', icon: Terminal },
  { id: 'editor', label: '编辑器', icon: FileCode2 },
  { id: 'modules', label: '模块', icon: Puzzle },
  { id: 'keys', label: '快捷键', icon: Keyboard },
];
```

`Puzzle` 从 `lucide-react` 引入。

- [ ] **Step 2: 渲染模块列表**

在设置面板里加 `tab === 'modules'` 的分支，列表项：

```tsx
          {tab === 'modules' ? (
            <>
              <div className="settings-group-title">
                模块
                <span className="settings-group-hint">
                  {EDITOR_MODULES.filter((item) => modules.includes(item.id)).length} /{' '}
                  {EDITOR_MODULES.length} 已启用
                </span>
              </div>
              {EDITOR_MODULES.map((item) => (
                <div className="settings-item" key={item.id}>
                  <div className="settings-item-text">
                    <span className="settings-item-label">{item.name}</span>
                    <span className="settings-item-desc">{item.description}</span>
                  </div>
                  <Toggle
                    checked={modules.includes(item.id)}
                    onChange={(next) => onModulesChange(item, next)}
                  />
                </div>
              ))}
            </>
          ) : null}
```

`onModulesChange` 直接改本地 state，**不写盘**——开关属于普通偏好，跟其他设置一样点「保存」才生效。这与「开机启动」不同：后者写系统状态，所以必须延迟到保存；模块开关只改 localStorage，立即生效也安全。设计稿写的是「立即生效」，实现上按「保存时一并写入，但视觉上立即反馈」处理，避免一次点击就触发 `writePrefs`。

- [ ] **Step 3: 更新 CLAUDE.md**

把：

```
- 设置页签顺序固定为 **关于 / 常规 / 终端 / 编辑器 / 快捷键**，「关于」必须第一位
```

改成：

```
- 设置页签顺序固定为 **关于 / 常规 / 终端 / 编辑器 / 模块 / 快捷键**，「关于」必须第一位
```

并在「不要做的事」附近补一条模块系统的约定（见 Task 7）。

- [ ] **Step 4: 运行全部测试**

Run: `npx tsc --noEmit && npx vite build && node tests/editor-modules.mjs && node tests/update-notify.mjs`
Expected: 两个测试都 PASS，确认页签调整没有破坏「关于」的断言

- [ ] **Step 5: 提交**

```bash
git add src/components/SettingsModal.tsx src/styles.css CLAUDE.md tests/editor-modules.mjs
git commit -m "feat(settings): 新增「模块」页签与开关"
```

---

## Task 7: 收尾与文档

**Files:**
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`（不升版本，只加「未发布」小节）

- [ ] **Step 1: 补 CLAUDE.md 的模块系统约定**

在「已知的坑」里加：

```markdown
- **压缩的自动触发条件是「同名 .min.js 是否存在」**，不是设置开关。不存在就绝不
  创建，存在才在每次保存时更新。钩子挂在 `useEditorFiles.save()` 里
  `if (!current.dirty) return false;` **之前**——用户要求「不管有没有修改都执行」，
  挂在后面会被这个早退拦住。
- **压缩失败不能导致保存失败**。`terser` 报错只推 toast，不 `throw`。
- **`files.write()` 不能创建新文件**（第一行 `fsp.stat` 会抛）。新建 `.min.js`
  必须走 `files:write-minified`。
- **模块依赖全部放 `devDependencies`**：它们被 vite 打进前端 bundle，运行时不从
  node_modules 读。放进 `dependencies` 会让安装包白白变大。
- **`ts`/`tsx` 不挂 acorn 诊断**：acorn 解析不了类型注解，挂上会满屏误报。
```

- [ ] **Step 2: CHANGELOG 加未发布小节**

```markdown
## [未发布]

### 新增

- **编辑器模块**：设置里新增「模块」页签，可单独开关代码格式化、JS 压缩、
  JS/TS 语法检查、PHP 语法检查
- **代码格式化**：编辑器右键「格式化文档」，或按 `Shift+Alt+F`。支持
  JS / TS / HTML / CSS / JSON / Markdown
- **JS 压缩**：右键「压缩为 xxx.min.js」生成压缩版；若同名 `.min.js` 已存在，
  之后每次保存 `.js` 都会自动更新它
- **语法诊断**：开启后编辑器里用波浪线标出 JS/TS 与 PHP 的语法错误
```

- [ ] **Step 3: 跑完整测试**

```bash
node tests/module-catalog.mjs
```

（GUI 测试见上一步，需独占端口）

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: 记录模块系统的约定与压缩触发规则"
```

---

## 自查结果

**规格覆盖**
- 范围表格的 4 个模块 → Task 1（清单）+ Task 3（格式化）+ Task 4（压缩）+ Task 5（诊断）
- 数据模型 → Task 1
- 模块接口 → Task 3 的 `registry.ts`
- 格式化入口（右键 + Shift+Alt+F）→ Task 3
- 压缩的手动/自动触发与 `.min.js` 存在性判定 → Task 4
- 诊断的 Compartment 与 linter → Task 5
- 设置界面「模块」页签 → Task 6
- 两条新 IPC → Task 2
- 依赖放 devDependencies → Task 3 Step 1
- 错误处理表 → Task 4 Step 4（压缩失败不阻塞保存）、Task 5 Step 3（开关关闭清空）
- 测试清单 → `tests/editor-modules.mjs` 分布在各 Task，`tests/module-catalog.mjs` 在 Task 1

**已知缺口**（诚实记录，实施时需自行补）
- `Ctrl+K Ctrl+F` 两段式快捷键未纳入计划，降级为菜单项「格式化选区」（设计稿已允许降级）
- `tests/editor-modules.mjs` 里「打开文件」的具体选择器需在实施时按真实 DOM 调整
- 设置开关是否「立即生效 vs 保存生效」，Task 6 采纳了「保存时写入」，与设计稿的「立即生效」有细微出入，以 Task 6 为准

**类型一致性**
- `Diagnostic` 在 `registry.ts` 定义，`diagnose-js.ts` / `diagnose-php.ts` 都 `import type { Diagnostic } from './registry'`，一致
- `minifiedName` 在 `minify.ts` 定义，`useEditorFiles.ts` 与 `EditorPane.tsx` 都从 `./modules/minify` 引入，一致
- `ModuleKind` / `EditorModule` 只在 `catalog.ts` 定义，其余文件 import，一致
