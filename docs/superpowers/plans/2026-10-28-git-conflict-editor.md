# 冲突解决实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在编辑器页签里识别 Git 冲突标记，给每个冲突块高亮并浮出「采用当前 / 采用传入 / 两者都保留」三个按钮。

**Architecture:** 纯前端实现——冲突信息完全由文件内容推导，不加 IPC。`src/conflictParser.ts` 解析标记块，`CodeMirrorHost` 用 `Decoration` 渲染区块底色与行内操作条，`EditorPane` 显示冲突计数徽标。

**Tech Stack:** React 19、TypeScript、CodeMirror 6（`@codemirror/view` 的 Decoration / WidgetType / StateField）

**规格：** `docs/superpowers/specs/2026-10-27-git-conflict-editor-design.md`

## Global Constraints

- 项目根目录：`D:\deskTop\CmdToolbox\cmd-toolbox`（git 仓库，基线 `3345b22`）
- 解析不完整时**返回空数组**，绝不猜测——宁可不高亮，也不能错误改写内容
- 替换通过 CodeMirror `dispatch({ changes })` 完成，必须落在撤销栈里
- 不自动保存、不自动 `git add`
- 文案中文，2 空格缩进，单引号
- 构建验证：`npm run typecheck && npx vite build`（**不要** `npm run build`）
- e2e 若端口 17382 被占用，用隔离副本（见下方）

## e2e 运行方法

1. 临时目录复制 `desktop/`、`dist/`、`build/`、`package.json`，`node_modules` 用目录联接指回原处
2. 副本 `desktop/pane-api.js` 的 `DEFAULT_PORT` 改 17997
3. 注释副本 `desktop/main.js` 的 `mcpConfig.installGlobal(mcp);`
4. `sed` 生成测试副本，`cwd: root` 改为副本路径
5. 测试开头加窗口置顶：

```js
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0];
  win?.show();
  win?.focus();
  win?.moveTop();
});
```

**绝不**杀掉用户正在运行的进程。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/conflictParser.ts` | 新增。解析冲突标记块，纯函数 |
| `src/components/ConflictBar.tsx` | 新增。冲突块上方的操作条 |
| `src/components/CodeMirrorHost.tsx` | 修改。冲突装饰、widget、解决动作 |
| `src/components/EditorPane.tsx` | 修改。冲突计数徽标、全部处理完提示 |
| `src/styles.css` | 修改。冲突区配色与操作条样式 |
| `tests/conflict-parser.mjs` | 新增。解析逻辑单元测试 |
| `tests/editor.mjs` | 修改。追加冲突解决端到端场景 |

---

### Task 1: 冲突解析器

**Files:**
- Create: `src/conflictParser.ts`
- Test: `tests/conflict-parser.mjs`

**Interfaces:**
- Produces:
  - `ConflictBlock = { startLine: number; separatorLine: number; endLine: number; baseLine: number | null; oursLabel: string; theirsLabel: string }`（行号为 0 基）
  - `parseConflicts(text: string) => ConflictBlock[]`
  - `resolveConflict(text: string, block: ConflictBlock, choice: 'ours' | 'theirs' | 'both') => { from: number; to: number; insert: string } | null`（返回 CodeMirror changes 所需的字符偏移）

- [ ] **Step 1: 写失败的测试**

`src/conflictParser.ts` 是 TypeScript，Node 不能直接 import。测试用 `tsc` 把单个文件编译到临时目录后再加载：

创建 `tests/conflict-parser.mjs`：

```js
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const outDir = mkdtempSync(join(tmpdir(), 'cmdtb-parser-'));

execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'tsc',
    'src/conflictParser.ts',
    '--outDir',
    outDir,
    '--module',
    'esnext',
    '--target',
    'es2022',
    '--moduleResolution',
    'bundler',
    '--skipLibCheck',
  ],
  { cwd: root, stdio: 'inherit' },
);

const compiled = join(outDir, 'conflictParser.js');
const { parseConflicts, resolveConflict } = await import(pathToFileURL(compiled).href);

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const STANDARD = ['a', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> feature/x', 'b'].join('\n');
const DIFF3 = ['<<<<<<< HEAD', 'ours', '||||||| base', 'base', '=======', 'theirs', '>>>>>>> feature/x'].join('\n');

console.log('1. 标准标记');
const one = parseConflicts(STANDARD);
assert(one.length === 1, '识别一个冲突块');
assert(one[0].startLine === 1 && one[0].separatorLine === 3 && one[0].endLine === 5, '行号正确（0 基）');
assert(one[0].baseLine === null, '标准形式没有基线段');
assert(one[0].oursLabel === 'HEAD', 'ours 标签正确');
assert(one[0].theirsLabel === 'feature/x', 'theirs 标签正确');

console.log('2. diff3 标记');
const d3 = parseConflicts(DIFF3);
assert(d3.length === 1, '识别 diff3 冲突块');
assert(d3[0].baseLine === 2, '基线段行号正确');

console.log('3. 多块');
const twoBlocks = [STANDARD, '', STANDARD].join('\n');
assert(parseConflicts(twoBlocks).length === 2, '识别两个冲突块');

console.log('4. 不完整标记返回空');
assert(parseConflicts(['<<<<<<< HEAD', 'ours', '=======', 'theirs'].join('\n')).length === 0, '缺少结束标记返回空');
assert(parseConflicts(['<<<<<<< HEAD', 'ours', '>>>>>>> x'].join('\n')).length === 0, '缺少分隔线返回空');

console.log('5. 无冲突');
assert(parseConflicts('hello\nworld').length === 0, '普通文本返回空');
assert(parseConflicts(['a', '<<<<<<< 出现在中间', 'b'].join('\n')).length === 0, '非行首标记不识别');

console.log('6. 采用当前');
const oursResult = resolveConflict(STANDARD, one[0], 'ours');
const applied = STANDARD.slice(0, oursResult.from) + oursResult.insert + STANDARD.slice(oursResult.to);
assert(applied === 'a\nours\nb', '采用当前后内容正确');

console.log('7. 采用传入');
const theirsResult = resolveConflict(STANDARD, one[0], 'theirs');
const appliedTheirs = STANDARD.slice(0, theirsResult.from) + theirsResult.insert + STANDARD.slice(theirsResult.to);
assert(appliedTheirs === 'a\ntheirs\nb', '采用传入后内容正确');

console.log('8. 两者都保留');
const bothResult = resolveConflict(STANDARD, one[0], 'both');
const appliedBoth = STANDARD.slice(0, bothResult.from) + bothResult.insert + STANDARD.slice(bothResult.to);
assert(appliedBoth === 'a\nours\ntheirs\nb', '两者都保留后内容正确');

console.log('9. diff3 采用当前丢弃基线段');
const d3Result = resolveConflict(DIFF3, d3[0], 'ours');
assert(DIFF3.slice(0, d3Result.from) + d3Result.insert + DIFF3.slice(d3Result.to) === 'ours', 'diff3 采用当前后只剩当前内容');

rmSync(outDir, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/conflict-parser.mjs`
Expected: FAIL，`Cannot find module 'src/conflictParser.ts'` 或编译错误

- [ ] **Step 3: 实现 `src/conflictParser.ts`**

```ts
export type ConflictBlock = {
  startLine: number;
  separatorLine: number;
  endLine: number;
  baseLine: number | null;
  oursLabel: string;
  theirsLabel: string;
};

export type ConflictChoice = 'ours' | 'theirs' | 'both';

export type ConflictEdit = {
  from: number;
  to: number;
  insert: string;
};

const MARKER = {
  start: '<<<<<<<',
  base: '|||||||',
  separator: '=======',
  end: '>>>>>>>',
};

function labelOf(line: string, marker: string): string {
  return line.slice(marker.length).trim();
}

// 扫描整篇文本。任何一个块缺少结束标记就整体放弃，避免错误改写。
export function parseConflicts(text: string): ConflictBlock[] {
  const lines = text.split('\n');
  const blocks: ConflictBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].startsWith(MARKER.start)) {
      index += 1;
      continue;
    }

    const startLine = index;
    const oursLabel = labelOf(lines[index], MARKER.start);
    let cursor = index + 1;
    let baseLine: number | null = null;
    let separatorLine = -1;

    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.startsWith(MARKER.end)) break;
      if (line.startsWith(MARKER.base) && separatorLine < 0 && baseLine === null) {
        baseLine = cursor;
      } else if (line.startsWith(MARKER.separator) && separatorLine < 0) {
        separatorLine = cursor;
      } else if (line.startsWith(MARKER.start)) {
        // 嵌套开始标记说明结构已乱，整体放弃
        return [];
      }
      cursor += 1;
    }

    if (cursor >= lines.length) return [];
    if (separatorLine < 0) return [];
    if (baseLine !== null && baseLine > separatorLine) return [];

    blocks.push({
      startLine,
      separatorLine,
      endLine: cursor,
      baseLine,
      oursLabel,
      theirsLabel: labelOf(lines[cursor], MARKER.end),
    });

    index = cursor + 1;
  }

  return blocks;
}

// 把块内的三个区段按选择拼成替换文本；行号换算成字符偏移。
export function resolveConflict(
  text: string,
  block: ConflictBlock,
  choice: ConflictChoice,
): ConflictEdit | null {
  const lines = text.split('\n');
  if (block.endLine >= lines.length || block.separatorLine >= lines.length) return null;

  const oursEnd = block.baseLine ?? block.separatorLine;
  const ours = lines.slice(block.startLine + 1, oursEnd);
  const theirs = lines.slice(block.separatorLine + 1, block.endLine);

  let insert: string;
  if (choice === 'ours') insert = ours.join('\n');
  else if (choice === 'theirs') insert = theirs.join('\n');
  else insert = [...ours, ...theirs].join('\n');

  const from = offsetOfLine(lines, block.startLine);
  const to = block.endLine + 1 >= lines.length
    ? text.length
    : offsetOfLine(lines, block.endLine + 1);

  return { from, to, insert };
}

function offsetOfLine(lines: string[], lineIndex: number): number {
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) {
    offset += lines[index].length + 1;
  }
  return offset;
}
```

注意 `resolveConflict` 的 `to` 计算：替换范围必须覆盖整块（含结束标记行）以及其后的换行，否则会留下空行。

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/conflict-parser.mjs`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add src/conflictParser.ts tests/conflict-parser.mjs
git commit -m "feat(conflict): parse conflict markers and resolve blocks"
```

---

### Task 2: 编辑器内的冲突装饰与操作条

**Files:**
- Create: `src/components/ConflictBar.tsx`
- Modify: `src/components/CodeMirrorHost.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: Task 1 的 `parseConflicts` / `resolveConflict`
- Produces: `CodeMirrorHost` 新增 prop `onConflictCountChange?: (count: number) => void`

- [ ] **Step 1: 操作条组件**

创建 `src/components/ConflictBar.tsx`：

```tsx
import type { ConflictChoice } from '../conflictParser';

export type ConflictBarProps = {
  oursLabel: string;
  theirsLabel: string;
  onResolve: (choice: ConflictChoice) => void;
};

export function ConflictBar({ oursLabel, theirsLabel, onResolve }: ConflictBarProps) {
  return (
    <div className="conflict-bar">
      <button
        type="button"
        className="conflict-action"
        title={`保留「${oursLabel}」的内容`}
        onClick={() => onResolve('ours')}
      >
        采用当前
      </button>
      <button
        type="button"
        className="conflict-action"
        title={`保留「${theirsLabel}」的内容`}
        onClick={() => onResolve('theirs')}
      >
        采用传入
      </button>
      <button
        type="button"
        className="conflict-action"
        title="两段内容都保留"
        onClick={() => onResolve('both')}
      >
        两者都保留
      </button>
    </div>
  );
}
```

- [ ] **Step 2: CodeMirror 内的 widget 与装饰**

`src/components/CodeMirrorHost.tsx` 改为：

```tsx
import { useEffect, useRef } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, Decoration, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { EditorState, Compartment, StateField, RangeSetBuilder } from '@codemirror/state';
import type { EditorState as EditorStateType } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { createRoot } from 'react-dom/client';
import { languageFor } from '../editorLanguage';
import { vscodeLightExtensions } from '../editorTheme';
import { parseConflicts, resolveConflict } from '../conflictParser';
import type { ConflictBlock, ConflictChoice } from '../conflictParser';
import { ConflictBar } from './ConflictBar';

export type CodeMirrorHostProps = {
  value: string;
  filePath: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  onConflictCountChange?: (count: number) => void;
};

class ConflictWidget extends WidgetType {
  constructor(readonly block: ConflictBlock) {
    super();
  }

  eq(other: ConflictWidget) {
    return (
      other.block.startLine === this.block.startLine &&
      other.block.endLine === this.block.endLine &&
      other.block.oursLabel === this.block.oursLabel &&
      other.block.theirsLabel === this.block.theirsLabel
    );
  }

  toDOM(view: EditorView) {
    const host = document.createElement('div');
    const root = createRoot(host);
    root.render(
      <ConflictBar
        oursLabel={this.block.oursLabel}
        theirsLabel={this.block.theirsLabel}
        onResolve={(choice) => applyConflictChoice(view, this.block, choice)}
      />,
    );
    // widget 被移除时销毁 React 根
    host.addEventListener('conflict-widget-removed', () => root.unmount(), { once: true });
    return host;
  }

  destroy(dom: HTMLElement) {
    dom.dispatchEvent(new Event('conflict-widget-removed'));
  }
}

function applyConflictChoice(view: EditorView, block: ConflictBlock, choice: ConflictChoice) {
  const edit = resolveConflict(view.state.doc.toString(), block, choice);
  if (!edit) return;
  view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert } });
}

const oursMark = Decoration.line({ class: 'cm-conflict-ours' });
const theirsMark = Decoration.line({ class: 'cm-conflict-theirs' });
const markerMark = Decoration.line({ class: 'cm-conflict-marker' });

function buildDecorations(state: EditorStateType): DecorationSet {
  const text = state.doc.toString();
  const blocks = parseConflicts(text);
  if (!blocks.length) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  for (const block of blocks) {
    const startPos = state.doc.line(block.startLine + 1).from;
    builder.add(startPos, startPos, Decoration.widget({ widget: new ConflictWidget(block), side: -1 }));

    const oursEnd = block.baseLine ?? block.separatorLine;
    for (let line = block.startLine + 1; line <= oursEnd; line += 1) {
      const pos = state.doc.line(line + 1).from;
      builder.add(pos, pos, oursMark);
    }
    for (let line = block.separatorLine; line <= block.endLine; line += 1) {
      const pos = state.doc.line(line + 1).from;
      builder.add(pos, pos, line === block.separatorLine ? markerMark : theirsMark);
    }
    for (const marker of [block.startLine, block.baseLine, block.endLine]) {
      if (marker === null || marker === undefined) continue;
      const pos = state.doc.line(marker + 1).from;
      builder.add(pos, pos, markerMark);
    }
  }
  return builder.finish();
}

const conflictField = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(value, tr) {
    if (!tr.docChanged) return value;
    return buildDecorations(tr.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function CodeMirrorHost({
  value,
  filePath,
  readOnly,
  onChange,
  onConflictCountChange,
}: CodeMirrorHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageRef = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onCountRef = useRef(onConflictCountChange);
  onChangeRef.current = onChange;
  onCountRef.current = onConflictCountChange;

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
          ...vscodeLightExtensions,
          conflictField,
          languageRef.current.of([]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
              onCountRef.current?.(parseConflicts(update.state.doc.toString()).length);
            }
          }),
          EditorState.readOnly.of(readOnly),
        ],
      }),
    });
    viewRef.current = view;
    onCountRef.current?.(parseConflicts(value).length);

    void languageFor(filePath).then((extension) => {
      if (disposed || !extension) return;
      view.dispatch({ effects: languageRef.current.reconfigure(extension) });
    });

    return () => {
      disposed = true;
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    onCountRef.current?.(parseConflicts(value).length);
  }, [value]);

  return <div className="codemirror-host" ref={hostRef} />;
}
```

`RangeSetBuilder` 要求按位置递增添加；上面先加 widget 再加同位置的 line 装饰，位置相同不违反顺序，但**必须保证整体位置单调递增**。若运行时报 `RangeSetBuilder` 顺序错误，改为先收集所有 `{pos, deco}` 到数组、按 `pos` 排序后再依次 `add`。

- [ ] **Step 3: 样式**

`src/styles.css` 中 `.codemirror-host` 规则之后加入：

```css
.cm-conflict-ours {
  background: #e8f0fe;
}

.cm-conflict-theirs {
  background: #e6f4ea;
}

.cm-conflict-marker {
  background: #f0f0f0;
  color: #9a9da5;
}

.conflict-bar {
  display: flex;
  gap: 6px;
  padding: 3px 0 3px 26px;
  background: #fafafa;
  border-top: 1px solid #ececef;
  border-bottom: 1px solid #ececef;
}

.conflict-action {
  padding: 2px 8px;
  border: 1px solid #d7d9de;
  border-radius: 5px;
  background: #ffffff;
  color: #3f4249;
  font-size: 11px;
  line-height: 1.5;
}

.conflict-action:hover {
  background: #f2f4ff;
  border-color: #b9c2ff;
  color: #2f3ee0;
}
```

- [ ] **Step 4: 验证**

Run: `npm run typecheck && npx vite build`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add src/components/ConflictBar.tsx src/components/CodeMirrorHost.tsx src/styles.css
git commit -m "feat(conflict): highlight conflict blocks with resolve actions"
```

---

### Task 3: 面板徽标与提示

**Files:**
- Modify: `src/components/EditorPane.tsx`

**Interfaces:**
- Consumes: Task 2 的 `onConflictCountChange`

- [ ] **Step 1: 冲突状态与徽标**

`src/components/EditorPane.tsx` 中，`useEditorFile` 调用之后加入：

```tsx
  const [conflictCount, setConflictCount] = useState(0);
```

打开新文件时清零：

```tsx
  useEffect(() => {
    setConflictCount(0);
  }, [file.relPath]);
```

头部在编码标签之前插入徽标：

```tsx
        {conflictCount > 0 ? (
          <span className="editor-conflict-badge" title={`还有 ${conflictCount} 处冲突未处理`}>
            冲突 {conflictCount} 处
          </span>
        ) : null}
```

`CodeMirrorHost` 传参中加入：

```tsx
              onConflictCountChange={setConflictCount}
```

- [ ] **Step 2: 全部处理完的提示**

用 state 记录「这个文件曾有过冲突」，全部处理完且尚未保存时给出提示：

```tsx
  const [hadConflict, setHadConflict] = useState(false);
```

在 `file.relPath` 变化时重置，在 `conflictCount` 变为正数时置真：

```tsx
  useEffect(() => {
    setHadConflict(false);
  }, [file.relPath]);

  useEffect(() => {
    if (conflictCount > 0) setHadConflict(true);
  }, [conflictCount]);
```

在 `editor-notice` 那段之后渲染：

```tsx
      {hadConflict && conflictCount === 0 && file.dirty ? (
        <p className="editor-notice editor-notice-done">
          冲突已全部处理。按 Ctrl+S 保存，然后点「暂存」标记为已解决。
        </p>
      ) : null}
```

- [ ] **Step 3: 样式**

`src/styles.css` 中 `.editor-encoding` 之后加入：

```css
.editor-conflict-badge {
  padding: 1px 7px;
  border-radius: 999px;
  background: #fde8e8;
  color: #b42318;
  font-size: 10.5px;
  font-weight: 600;
}

.editor-notice-done {
  background: #e8f4ea;
  border-bottom-color: #bfe0c6;
  color: #1a7f37;
}
```

- [ ] **Step 4: 验证**

Run: `npm run typecheck && npx vite build`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add src/components/EditorPane.tsx src/styles.css
git commit -m "feat(conflict): show conflict count badge and resolved hint"
```

---

### Task 4: 端到端测试

**Files:**
- Modify: `tests/editor.mjs`

**Interfaces:**
- Consumes: 全部前序任务

- [ ] **Step 1: 追加冲突场景**

在 `tests/editor.mjs` 的 `await app.close();` 之前追加：

```js
console.log('11. 打开冲突文件显示操作条');
const conflictRepo = mkdtempSync(join(tmpdir(), 'cmdtb-conflict-'));
execFileSync('git', ['init', '-b', 'main'], { cwd: conflictRepo, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: conflictRepo });
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: conflictRepo });
execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: conflictRepo });
writeFileSync(join(conflictRepo, 'file.txt'), 'base\n');
execFileSync('git', ['add', '-A'], { cwd: conflictRepo });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: conflictRepo });
execFileSync('git', ['checkout', '-q', '-b', 'other'], { cwd: conflictRepo });
writeFileSync(join(conflictRepo, 'file.txt'), 'theirs\n');
execFileSync('git', ['commit', '-qam', 'other'], { cwd: conflictRepo });
execFileSync('git', ['checkout', '-q', 'main'], { cwd: conflictRepo });
writeFileSync(join(conflictRepo, 'file.txt'), 'ours\n');
execFileSync('git', ['commit', '-qam', 'main'], { cwd: conflictRepo });
try {
  execFileSync('git', ['merge', 'other'], { cwd: conflictRepo, stdio: 'ignore' });
} catch {
  // 合并冲突是预期结果
}

await addProject(conflictRepo, 'conflict-proj');
await selectProject('conflict-proj');
await page.locator('.group-item').filter({ hasText: 'conflict-proj' }).click({ button: 'right' });
await page.locator('.popup-menu').waitFor({ timeout: 8000 });
await click(page.getByRole('menuitem', { name: '打开编辑器', exact: true }));
await page.waitForTimeout(1200);
await click(page.locator('.editor-pane .file-row').filter({ hasText: 'file.txt' }));
await waitFor(
  async () => (await page.locator('.conflict-bar').count()) > 0,
  '冲突操作条出现',
);
assert(
  (await page.locator('.editor-conflict-badge').innerText()).includes('冲突 1 处'),
  '徽标显示冲突数量',
);

console.log('12. 采用当前');
await click(page.getByRole('button', { name: '采用当前', exact: true }));
await waitFor(
  async () => (await page.locator('.conflict-bar').count()) === 0,
  '操作条消失',
);
const currentText = await page.locator('.editor-pane .cm-content').innerText();
assert(currentText.includes('ours') && !currentText.includes('theirs'), '只剩当前分支内容');
assert(
  (await page.locator('.editor-notice-done').count()) > 0,
  '出现「冲突已全部处理」提示',
);

console.log('13. Ctrl+Z 撤销恢复冲突');
await page.locator('.editor-pane .cm-content').click();
await page.keyboard.press('Control+Z');
await waitFor(
  async () => (await page.locator('.conflict-bar').count()) > 0,
  '撤销后操作条恢复',
);

console.log('14. 采用传入');
await click(page.getByRole('button', { name: '采用传入', exact: true }));
await waitFor(
  async () => (await page.locator('.conflict-bar').count()) === 0,
  '操作条消失',
);
const theirsText = await page.locator('.editor-pane .cm-content').innerText();
assert(theirsText.includes('theirs') && !theirsText.includes('ours'), '只剩传入分支内容');
```

文件顶部 import 补 `execFileSync` 与 `mkdtempSync`、`tmpdir`（部分可能已有，去重）。

- [ ] **Step 2: 运行测试**

Run: 隔离副本方式运行 `tests/editor.mjs`
Expected: 全部通过

- [ ] **Step 3: 全套回归**

Run: `node tests/conflict-parser.mjs`
Run: `node tests/git-core.mjs`
Run: 隔离副本 `tests/git-panel.mjs`
Run: 隔离副本 `tests/editor.mjs`
Expected: 全部通过

- [ ] **Step 4: 提交**

```bash
git add tests/editor.mjs
git commit -m "test(conflict): cover conflict resolution end to end"
```

---

## 计划自检

**规格覆盖**

| 规格条目 | 任务 |
|---|---|
| 识别冲突标记块 | Task 1 |
| 兼容 diff3 的 `\|\|\|\|\|\|\|` | Task 1 |
| 三个区段着色 | Task 2 |
| 每块浮出三个按钮 | Task 2 |
| 改动落在撤销栈 | Task 2（`dispatch({changes})`） |
| 全部处理完提示 | Task 3 |
| 不自动保存/暂存 | 全任务（无相关调用） |
| 解析器测试 | Task 1 |
| 端到端测试 | Task 4 |

**已知风险**

- `RangeSetBuilder` 要求严格的位置递增。Task 2 Step 2 的实现在同一位置先加 widget 再加 line 装饰，可能触发顺序断言。计划中已给出退路：改为收集后排序再 `add`。
- 测试里用 `npx tsc` 单文件编译，Windows 上需 `npx.cmd`，计划中已处理。
- `tests/editor.mjs` 新增的 `addProject` / `selectProject` 是现有辅助函数，必须确认它们在文件里已定义（Task 3 的实现里已有），否则复用会报未定义。

**类型一致性**

`ConflictBlock` 在 Task 1 定义，Task 2 的 `ConflictWidget` 与 `buildDecorations` 消费；`ConflictChoice` 在 Task 1 定义，Task 2 的 `applyConflictChoice` 消费；`onConflictCountChange` 在 Task 2 定义，Task 3 消费。
