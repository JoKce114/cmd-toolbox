import { useEffect, useRef } from 'react';
import {
  EditorView,
  keymap,
  lineNumbers as lineNumbersExtension,
  highlightActiveLine as highlightActiveLineExtension,
  highlightWhitespace,
  Decoration,
  WidgetType,
  showTooltip,
  ViewPlugin,
  gutter,
  GutterMarker,
} from '@codemirror/view';
import type { DecorationSet, Tooltip } from '@codemirror/view';
import {
  EditorState,
  Compartment,
  StateField,
  StateEffect,
  RangeSetBuilder,
  Transaction,
  EditorSelection,
} from '@codemirror/state';
import type { EditorState as EditorStateType, Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  bracketMatching as bracketMatchingExtension,
  foldGutter,
  foldKeymap,
  indentUnit,
} from '@codemirror/language';
import { bindingsExtension } from '../editorKeymap';
import type { KeyBindingMap } from '../editorKeymap';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { lintGutter, linter } from '@codemirror/lint';
import { createRoot } from 'react-dom/client';
import { languageFor } from '../editorLanguage';
import { searchPhrases } from '../editorSearchPhrases';
import { editorAppearanceExtension, themeExtensions } from '../editorTheme';
import type { EditorFontFamily } from '../prefs';
import type { TerminalThemeMode } from '../theme';
import { parseConflicts, resolveConflict } from '../conflictParser';
import type { ConflictBlock, ConflictChoice } from '../conflictParser';
import { ConflictBar } from './ConflictBar';
import type { EditorModule } from '../modules/catalog';
import { SymbolCard } from './SymbolCard';
import type { SymbolCardState } from './SymbolCard';
import { lookupSymbol, wordAndReceiverAt } from '../symbolLookup';
import type { SymbolMatch } from '../types';
import { isUntitledPath } from '../untitledPath';
import type { LineChangeKind, LineChanges } from '../lineChanges';
import { lookupBlame, lookupCommitFileDiff, pickHunkForLine } from '../blameLookup';
import type { BlameInfo } from '../blameLookup';
import type { DiffHunk } from '../diffParser';
import { BlameCard } from './BlameCard';
import type { BlameCardState } from './BlameCard';

export type CodeMirrorHostProps = {
  value: string;
  filePath: string;
  readOnly: boolean;
  themeMode: TerminalThemeMode;
  wordWrap: boolean;
  tabSize: number;
  indentWithSpaces: boolean;
  keybindings: KeyBindingMap;
  fontSize: number;
  lineHeight: number;
  fontFamily: EditorFontFamily;
  showLineNumbers: boolean;
  highlightActiveLine: boolean;
  bracketMatching: boolean;
  showWhitespace: boolean;
  // 当前文件命中的诊断模块；null 表示不挂 linter。
  // 由上层按文件扩展名与 enabledModules 算好，避免把数组依赖带进 effect。
  diagnosticModule: EditorModule | null;
  referenceEnabled: boolean;
  projectPath: string;
  onJumpToSymbol: (match: SymbolMatch) => void;
  gotoLine: number | null;
  // 定位完成后通知上层把 gotoLine 复位为 null。必填：漏传时 prevGotoLineRef
  // 永远不会回到 null，第二次跳转起会被静默忽略。
  onGotoLineApplied: () => void;
  onFontSizeDelta?: (delta: number) => void;
  onChange: (value: string) => void;
  onConflictCountChange?: (count: number) => void;
  // 与 Git HEAD 的行级差异；null 表示不显示标记
  changeMarkers?: LineChanges | null;
  // 是否响应行号点击看 blame（只读文件与空白窗口由上层关掉）
  blameEnabled?: boolean;
  // 悬停在内联小字上多久才弹出卡片（毫秒）
  blameHoverDelay?: number;
  // 有未保存修改时编辑器行号与磁盘行号对不上，点行号不查 blame，
  // 只提示「保存后查看」。由上层按 file.dirty 传入。
  blameBlocked?: boolean;
};

type CardFieldValue = { pos: number; card: SymbolCardState; seq: number } | null;

// 请求序号全局单调递增：reconfigure 会重建扩展闭包里的局部计数，
// 用模块级计数才能保证跨扩展重建依然能区分新旧请求。
let nextCardSeq = 1;

const setCard = StateEffect.define<CardFieldValue>();

const cardField = StateField.define<CardFieldValue>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCard)) return effect.value;
    }
    // 内容改动或用户显式关闭时收起卡片
    if (tr.docChanged) return null;
    return value;
  },
});

// 卡片用 React 渲染，卸载交给 tooltip 的 destroy
function createCardDom(
  card: SymbolCardState,
  onJump: (match: SymbolMatch) => void,
  onClose: () => void,
): { dom: HTMLElement; destroy: () => void } {
  const host = document.createElement('div');
  const root = createRoot(host);
  root.render(<SymbolCard card={card} onJump={onJump} onClose={onClose} />);
  return { dom: host, destroy: () => root.unmount() };
}

const setChangeMarkers = StateEffect.define<LineChanges | null>();

type MarkerSpans = {
  // 行首位置 → 类型；存位置而不是行号，用户编辑时才能用 mapPos 跟随
  bars: Map<number, LineChangeKind>;
  deletes: Map<number, string[]>;
};

const EMPTY_SPANS: MarkerSpans = { bars: new Map(), deletes: new Map() };

function spansFromLines(state: EditorStateType, changes: LineChanges): MarkerSpans {
  const doc = state.doc;
  const startOf = (line: number) => doc.line(Math.min(Math.max(1, line), doc.lines)).from;

  const bars = new Map<number, LineChangeKind>();
  for (const chunk of changes.chunks) {
    const from = Math.max(1, chunk.startLine);
    const to = Math.min(chunk.endLine, doc.lines);
    for (let line = from; line <= to; line += 1) bars.set(startOf(line), chunk.kind);
  }

  const deletes = new Map<number, string[]>();
  for (const anchor of changes.deletes) deletes.set(startOf(anchor.line), anchor.texts);
  return { bars, deletes };
}

// mapPos 的结果可能落在行中间（行首回车、跨行删除、行首打字都会），
// 而标记以 line.from 为键。统一吸附回行首，否则这一行的标记会凭空消失。
function snapToLineStart(state: EditorStateType, pos: number): number {
  const doc = state.doc;
  return doc.lineAt(Math.min(Math.max(pos, 0), doc.length)).from;
}

const changeMarkerField = StateField.define<MarkerSpans>({
  create: () => EMPTY_SPANS,
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(setChangeMarkers)) {
        next = effect.value ? spansFromLines(tr.state, effect.value) : EMPTY_SPANS;
      }
    }
    // 上一次标记还没被新行号覆盖时，按位置跟随，避免打字时下方标记整体错行。
    // 一律用 assoc = 1：行首回车后落到新空行行首，行首打字后仍吸附回原行首。
    if (tr.docChanged && next === value && value !== EMPTY_SPANS) {
      const bars = new Map<number, LineChangeKind>();
      for (const [pos, kind] of value.bars) {
        bars.set(snapToLineStart(tr.state, tr.changes.mapPos(pos, 1)), kind);
      }
      const deletes = new Map<number, string[]>();
      for (const [pos, texts] of value.deletes) {
        deletes.set(snapToLineStart(tr.state, tr.changes.mapPos(pos, 1)), texts);
      }
      next = { bars, deletes };
    }
    return next;
  },
});

function sameTexts(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

class ChangeGutterMarker extends GutterMarker {
  constructor(
    readonly kind: LineChangeKind | null,
    readonly deleted: string[] | null,
  ) {
    super();
  }

  eq(other: GutterMarker): boolean {
    const target = other as ChangeGutterMarker;
    return this.kind === target.kind && sameTexts(this.deleted, target.deleted);
  }

  toDOM(): HTMLElement {
    const host = document.createElement('div');
    host.className = 'cm-change-marker';
    if (this.kind) host.classList.add(`is-${this.kind}`);
    if (this.deleted) {
      const triangle = document.createElement('span');
      triangle.className = 'cm-change-triangle';
      const head = this.deleted.slice(0, 5);
      const rest = this.deleted.length - head.length;
      triangle.title = head.join('\n') + (rest > 0 ? `\n… 还有 ${rest} 行` : '');
      host.appendChild(triangle);
    }
    return host;
  }
}

const changeGutter = gutter({
  class: 'cm-change-gutter',
  lineMarker(view, line) {
    const spans = view.state.field(changeMarkerField, false);
    if (!spans) return null;
    const kind = spans.bars.get(line.from) ?? null;
    const deleted = spans.deletes.get(line.from) ?? null;
    if (!kind && !deleted) return null;
    return new ChangeGutterMarker(kind, deleted);
  },
  // 必须显式声明。SingleGutterView.update() 里重算的是 config.markers（本 gutter
  // 用的是 lineMarker，这个 RangeSet 恒为空），RangeSet.eq 因此恒为「没变化」；
  // lineMarker 只在 syncGutters 里调用，而 syncGutters 由 docChanged / 高度 /
  // 视口变化或本回调触发。纯 setChangeMarkers effect 三者都不变，不写这行
  // gutter 不会重绘。
  lineMarkerChange: (update) =>
    update.startState.field(changeMarkerField, false) !==
    update.state.field(changeMarkerField, false),
});

// 中键与左键一样做普通文本选择。必须把 mousemove / mouseup 挂在 window 上：
// 拖到编辑器外再松手时，只挂编辑器 DOM 会收不到 mouseup，选区会一直跟着鼠标走。
const middleClickSelection = ViewPlugin.fromClass(
  class {
    private readonly view: EditorView;
    private anchor: number | null = null;

    private readonly onMove = (event: MouseEvent) => {
      if (this.anchor === null) return;
      if ((event.buttons & 4) === 0) {
        this.stop();
        return;
      }
      const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
      // 拖出编辑器外时 posAtCoords 返回 null，保留上一次的位置，不跳回
      if (pos === null) return;
      this.view.dispatch({ selection: EditorSelection.range(this.anchor, pos) });
    };

    private readonly onUp = () => this.stop();

    constructor(view: EditorView) {
      this.view = view;
    }

    destroy() {
      this.stop();
    }

    private stop() {
      this.anchor = null;
      window.removeEventListener('mousemove', this.onMove);
      window.removeEventListener('mouseup', this.onUp);
    }

    handleMouseDown(event: MouseEvent): boolean {
      if (event.button !== 1) return false;
      const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      // 不 preventDefault 会让 Chromium 进入中键自动滚动模式
      event.preventDefault();
      this.stop();
      this.anchor = pos;
      // 中键不会触发 CodeMirror 的聚焦逻辑；不聚焦时选区只存在于 state 里，DOM 上看不到。
      this.view.focus();
      this.view.dispatch({ selection: EditorSelection.cursor(pos) });
      window.addEventListener('mousemove', this.onMove);
      window.addEventListener('mouseup', this.onUp);
      return true;
    }
  },
  {
    eventHandlers: {
      mousedown(event) {
        return this.handleMouseDown(event);
      },
    },
  },
);

// bars 以行首位置为键，多行变更块的每一行都有一条。直接拿所有 key 排序会把
// 一个 5 行的块拆成 5 个跳转目标。按行号把相邻行合并成块，只返回每块的首行。
function changeBlockStarts(
  doc: EditorStateType['doc'],
  bars: Map<number, LineChangeKind>,
): number[] {
  const lines = [...bars.keys()]
    .map((pos) => doc.lineAt(pos).number)
    .sort((a, b) => a - b);
  const starts: number[] = [];
  let previous = -2;
  for (const line of lines) {
    if (line === previous) continue;
    if (line !== previous + 1) starts.push(line);
    previous = line;
  }
  return starts;
}

// 只在编辑器有焦点时生效，不与终端 / 浏览器的 F5 抢键
function jumpToNextChange(view: EditorView): boolean {
  const spans = view.state.field(changeMarkerField, false);
  if (!spans || spans.bars.size === 0) return true; // 吃掉按键，不弹提示

  const doc = view.state.doc;
  const currentLine = doc.lineAt(view.state.selection.main.head).number;
  const starts = changeBlockStarts(doc, spans.bars);
  const target = starts.find((line) => line > currentLine) ?? starts[0];
  const pos = doc.line(target).from;

  view.dispatch({
    selection: EditorSelection.cursor(pos),
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  });
  return true;
}

const changeKeymap = keymap.of([
  { key: 'Alt-F5', run: jumpToNextChange, preventDefault: true },
]);

type BlameFieldValue = {
  line: number;
  // blocked：有未保存修改，编辑器行号映射不到磁盘行号，只能提示保存后再看
  status: 'loading' | 'ready' | 'failed' | 'blocked';
  info: BlameInfo | null;
  hunk: DiffHunk | null;
  // 提交片段尚未取回。行内小字只需要 info，先显示出来；
  // 卡片要的 hunk 等悬停时再取，避免把感知延迟从一条 git 命令变成两条。
  hunkPending: boolean;
} | null;

const setBlame = StateEffect.define<BlameFieldValue>();

const blameField = StateField.define<BlameFieldValue>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setBlame)) return effect.value;
    }
    // 改动后行号已经对不上，宁可收起
    if (tr.docChanged) return null;
    return value;
  },
});

// showTooltip 是「字段有值就显示」；不加这层门控，点完行号卡片会立刻盖住正文。
const setBlameHover = StateEffect.define<boolean>();

const blameHoverField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setBlameHover)) return effect.value;
    }
    if (tr.docChanged) return false;
    return value;
  },
});

class BlameWidget extends WidgetType {
  constructor(readonly value: NonNullable<BlameFieldValue>) {
    super();
  }

  eq(other: BlameWidget): boolean {
    return (
      other.value.line === this.value.line &&
      other.value.status === this.value.status &&
      other.value.info?.hash === this.value.info?.hash
    );
  }

  toDOM(): HTMLElement {
    const host = document.createElement('span');
    host.className = 'cm-blame-inline';
    if (this.value.status === 'loading') {
      host.textContent = '正在读取提交…';
    } else if (this.value.status === 'blocked') {
      host.textContent = '有未保存修改，保存后查看提交信息';
    } else if (this.value.status === 'failed' || !this.value.info) {
      host.textContent = '没有提交记录';
    } else {
      const { info } = this.value;
      host.textContent = `${info.author} · ${info.short} · ${info.summary}`;
    }
    return host;
  }
}

const blameDecorations = EditorView.decorations.compute([blameField], (state) => {
  const value = state.field(blameField, false);
  if (!value) return Decoration.none;
  const line = state.doc.line(Math.min(value.line, state.doc.lines));
  return Decoration.set([Decoration.widget({ widget: new BlameWidget(value), side: 1 }).range(line.to)]);
});

function referenceExtension(options: {
  isEnabled: () => boolean;
  lookup: (name: string, receiver: string, line: number) => Promise<SymbolCardState>;
  onJump: (match: SymbolMatch) => void;
}): Extension {
  const handlers = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!event.ctrlKey && !event.metaKey) {
        // 点卡片本身不算「点别处」，否则按钮会在 click 触发前被卸载
        const onCard =
          event.target instanceof Element && event.target.closest('.cm-tooltip');
        if (!onCard && view.state.field(cardField, false)) {
          view.dispatch({ effects: setCard.of(null) });
        }
        return false;
      }
      if (!options.isEnabled()) return false;
      // 只接管左键；Ctrl+右键保留浏览器/系统默认行为
      if (event.button !== 0) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const word = wordAndReceiverAt(view.state, pos);
      if (!word) return false;

      event.preventDefault();
      const seq = nextCardSeq++;

      // 变量在所在方法里通常只有一个声明，弹卡片再点一次是多余的一步：
      // 查到就直接跳过去。查不到才弹卡片给出反馈。
      if (word.name.startsWith('$')) {
        void options.lookup(word.name, word.receiver, word.line).then((card) => {
          if (view.state.field(cardField, false) === undefined) return;
          if (!card.failed && card.matches.length > 0) {
            options.onJump(card.matches[0]);
            return;
          }
          view.dispatch({ effects: setCard.of({ pos: word.from, card, seq }) });
        });
        return true;
      }

      view.dispatch({
        effects: setCard.of({
          pos: word.from,
          card: { name: word.name, loading: true, truncated: false, matches: [], failed: false },
          seq,
        }),
      });

      void options.lookup(word.name, word.receiver, word.line).then((card) => {
        if (view.state.field(cardField, false) === undefined) return;
        const current = view.state.field(cardField);
        // 序号不一致说明期间又发起了新查询、卡片已关闭或编辑器已重建
        if (!current || current.seq !== seq) return;
        view.dispatch({ effects: setCard.of({ pos: current.pos, card, seq }) });
      });
      return true;
    },
    mouseover(event, view) {
      if (!event.ctrlKey && !event.metaKey) return false;
      if (!options.isEnabled()) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const word = wordAndReceiverAt(view.state, pos);
      view.dom.classList.toggle('cm-symbol-clickable', Boolean(word));
      return false;
    },
    keyup(event, view) {
      // 松开 Ctrl/Meta 后立即恢复普通光标，不必等鼠标离开编辑器
      if (event.ctrlKey || event.metaKey) return false;
      view.dom.classList.remove('cm-symbol-clickable');
      return false;
    },
    mouseleave(_event, view) {
      view.dom.classList.remove('cm-symbol-clickable');
      return false;
    },
  });

  const tooltipFromField = showTooltip.from(cardField, (value) =>
    value
      ? ({
          pos: value.pos,
          above: true,
          // create 收到的 view 用来关闭卡片：tooltip 的 DOM 挂在编辑器容器里，
          // 从 DOM 反查拿不到 EditorView，必须用它
          create: (view) => {
            const { dom, destroy } = createCardDom(
              value.card,
              (match) => {
                options.onJump(match);
                // 同文件跳转不会切换 filePath，卡片必须在这里主动收起
                view.dispatch({ effects: setCard.of(null) });
              },
              () => view.dispatch({ effects: setCard.of(null) }),
            );
            return { dom, destroy };
          },
        } satisfies Tooltip)
      : null,
  );

  // 编辑器之外的点击（文件树、页签栏等）不会经过 domEventHandlers，
  // 这里在 document 捕获阶段兜住；编辑器内部的点击交给上面的 mousedown。
  const outsideClick = ViewPlugin.fromClass(
    class {
      private readonly view: EditorView;
      private readonly onMouseDown = (event: MouseEvent) => {
        if (!this.view.state.field(cardField, false)) return;
        if (event.target instanceof Node && this.view.dom.contains(event.target)) return;
        this.view.dispatch({ effects: setCard.of(null) });
      };

      constructor(view: EditorView) {
        this.view = view;
        view.dom.ownerDocument.addEventListener('mousedown', this.onMouseDown, true);
      }

      destroy() {
        this.view.dom.ownerDocument.removeEventListener('mousedown', this.onMouseDown, true);
      }
    },
  );

  return [cardField, tooltipFromField, handlers, outsideClick];
}

function blameExtension(options: {
  isEnabled: () => boolean;
  hoverDelay: () => number;
  onLineClick: (line: number) => void;
  requestHunk: (line: number) => void;
}): Extension {
  // EditorView.domEventHandlers 只挂在 .cm-content 上，收不到 gutter 的点击
  // （gutter 是它的同级节点），所以交互监听必须挂到整个编辑器 DOM。
  const interaction = ViewPlugin.fromClass(
    class {
      private readonly view: EditorView;
      private hideTimer = -1;
      private showTimer = -1;

      private readonly cancelShow = () => {
        if (this.showTimer >= 0) {
          window.clearTimeout(this.showTimer);
          this.showTimer = -1;
        }
      };

      private readonly isCardTarget = (target: EventTarget | null) =>
        target instanceof Element &&
        (target.closest('.cm-blame-inline') !== null || target.closest('.blame-card') !== null);

      private readonly onMouseDown = (event: MouseEvent) => {
        if (event.button !== 0) return;
        const target = event.target instanceof Element ? event.target : null;
        if (
          target &&
          !this.isCardTarget(target) &&
          this.view.state.field(blameHoverField, false)
        ) {
          this.view.dispatch({ effects: setBlameHover.of(false) });
        }
        if (!options.isEnabled() || !target) return;
        // 行号 / 变更 gutter 与正文都算：vscode 那边点整行就能看 blame，
        // 只认 gutter 会让用户点了正文却毫无反应。
        if (!target.closest('.cm-editor')) return;
        // 内联小字与卡片上的点击归它们自己处理，不要重复触发。
        if (this.isCardTarget(target)) return;

        const element = target.closest('.cm-gutterElement');
        let line: number;
        if (element && element.closest('.cm-lineNumbers, .cm-change-gutter')) {
          const rect = element.getBoundingClientRect();
          const block = this.view.lineBlockAtHeight(
            rect.top + rect.height / 2 - this.view.documentTop,
          );
          line = this.view.state.doc.lineAt(block.from).number;
          // gutter 上要拦掉默认行为；正文上不能拦，否则光标放不下去
          event.preventDefault();
        } else {
          const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos === null) return;
          line = this.view.state.doc.lineAt(pos).number;
        }
        options.onLineClick(line);
      };

      private readonly onMouseOver = (event: MouseEvent) => {
        if (!this.isCardTarget(event.target)) return;
        if (this.hideTimer >= 0) {
          window.clearTimeout(this.hideTimer);
          this.hideTimer = -1;
        }
        if (this.view.state.field(blameHoverField, false)) return;
        this.cancelShow();
        // 延迟由设置决定：0 立即弹出。鼠标移走后 cancelShow 会取消这次弹出，
        // 所以快速划过时不会一路弹出卡片。
        this.showTimer = window.setTimeout(() => {
          this.showTimer = -1;
          if (this.view.state.field(blameHoverField, false)) return;
          this.view.dispatch({ effects: setBlameHover.of(true) });
        }, Math.max(0, options.hoverDelay()));
      };

      private readonly onMouseOut = (event: MouseEvent) => {
        if (!this.isCardTarget(event.target)) return;
        if (this.isCardTarget(event.relatedTarget)) return;
        this.cancelShow();
        // 内联小字与卡片之间隔着一点空隙，立即收起会让卡片点不到
        if (this.hideTimer >= 0) window.clearTimeout(this.hideTimer);
        this.hideTimer = window.setTimeout(() => {
          this.hideTimer = -1;
          if (this.view.state.field(blameHoverField, false)) {
            this.view.dispatch({ effects: setBlameHover.of(false) });
          }
        }, 150);
      };

      constructor(view: EditorView) {
        this.view = view;
        view.dom.addEventListener('mousedown', this.onMouseDown);
        view.dom.addEventListener('mouseover', this.onMouseOver);
        view.dom.addEventListener('mouseout', this.onMouseOut);
      }

      destroy() {
        if (this.hideTimer >= 0) window.clearTimeout(this.hideTimer);
        this.cancelShow();
        this.view.dom.removeEventListener('mousedown', this.onMouseDown);
        this.view.dom.removeEventListener('mouseover', this.onMouseOver);
        this.view.dom.removeEventListener('mouseout', this.onMouseOut);
      }
    },
  );

  const tooltip = showTooltip.compute([blameField, blameHoverField], (state) => {
    const value = state.field(blameField, false);
    if (!value || value.status !== 'ready' || !value.info) return null;
    if (!state.field(blameHoverField, false)) return null;
    const info = value.info;
    return {
      pos: state.doc.line(Math.min(value.line, state.doc.lines)).to,
      above: false,
      create: () => {
        // diff 片段是悬停时才取的：点行号只等一条 git blame，卡片展开时才等第二条。
        // create 跑在 CodeMirror 的测量阶段，此时直接 dispatch 会撞上
        // 「update in progress」，所以推到当前任务之后。
        if (value.hunkPending) {
          const line = value.line;
          window.setTimeout(() => options.requestHunk(line), 0);
        }
        const host = document.createElement('div');
        const root = createRoot(host);
        const cardState: BlameCardState = { info, hunk: value.hunk, loading: value.hunkPending };
        root.render(<BlameCard state={cardState} />);
        return { dom: host, destroy: () => root.unmount() };
      },
    } satisfies Tooltip;
  });

  return [blameField, blameHoverField, interaction, blameDecorations, tooltip];
}

class ConflictWidget extends WidgetType {
  constructor(readonly block: ConflictBlock) {
    super();
  }

  eq(other: ConflictWidget) {
    return (
      other.block.startLine === this.block.startLine &&
      other.block.separatorLine === this.block.separatorLine &&
      other.block.endLine === this.block.endLine &&
      other.block.baseLine === this.block.baseLine &&
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

// RangeSetBuilder 要求按 from（以及同一位置下的 startSide）递增添加，
// 而冲突块内的标记行位置并非天然有序，所以先收集再排序。
function buildDecorations(state: EditorStateType): DecorationSet {
  const text = state.doc.toString();
  const blocks = parseConflicts(text);
  if (!blocks.length) return Decoration.none;

  const entries: { pos: number; deco: Decoration }[] = [];
  const push = (line: number, deco: Decoration) => {
    entries.push({ pos: state.doc.line(line + 1).from, deco });
  };

  for (const block of blocks) {
    push(block.startLine, Decoration.widget({ widget: new ConflictWidget(block), side: -1 }));

    const oursEnd = block.baseLine ?? block.separatorLine;
    for (let line = block.startLine + 1; line <= oursEnd; line += 1) {
      push(line, oursMark);
    }
    for (let line = block.separatorLine; line <= block.endLine; line += 1) {
      push(line, line === block.separatorLine ? markerMark : theirsMark);
    }
    for (const marker of [block.startLine, block.baseLine, block.endLine]) {
      if (marker === null || marker === undefined) continue;
      push(marker, markerMark);
    }
  }

  entries.sort((a, b) => a.pos - b.pos || a.deco.startSide - b.deco.startSide);

  const builder = new RangeSetBuilder<Decoration>();
  for (const { pos, deco } of entries) builder.add(pos, pos, deco);
  return builder.finish();
}

function displayExtensions(options: {
  showLineNumbers: boolean;
  highlightActiveLine: boolean;
  bracketMatching: boolean;
  showWhitespace: boolean;
}) {
  return [
    options.showLineNumbers ? lineNumbersExtension() : [],
    options.highlightActiveLine ? highlightActiveLineExtension() : [],
    options.bracketMatching ? bracketMatchingExtension() : [],
    options.showWhitespace ? highlightWhitespace() : [],
  ];
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
  themeMode,
  wordWrap,
  tabSize,
  indentWithSpaces,
  keybindings,
  fontSize,
  lineHeight,
  fontFamily,
  showLineNumbers,
  highlightActiveLine,
  bracketMatching,
  showWhitespace,
  diagnosticModule,
  referenceEnabled,
  projectPath,
  onJumpToSymbol,
  gotoLine,
  onGotoLineApplied,
  onFontSizeDelta,
  onChange,
  onConflictCountChange,
  changeMarkers,
  blameEnabled,
  blameHoverDelay = 1500,
  blameBlocked,
}: CodeMirrorHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageRef = useRef(new Compartment());
  const themeRef = useRef(new Compartment());
  const wrapRef = useRef(new Compartment());
  const indentRef = useRef(new Compartment());
  const keysRef = useRef(new Compartment());
  const appearanceRef = useRef(new Compartment());
  const displayRef = useRef(new Compartment());
  const diagnosticsRef = useRef(new Compartment());
  const referenceRef = useRef(new Compartment());
  const blameRef = useRef(new Compartment());
  const readOnlyRef = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onCountRef = useRef(onConflictCountChange);
  const onFontDeltaRef = useRef(onFontSizeDelta);
  const referenceEnabledRef = useRef(referenceEnabled);
  const blameEnabledRef = useRef(Boolean(blameEnabled));
  const blameBlockedRef = useRef(Boolean(blameBlocked));
  const blameHoverDelayRef = useRef(blameHoverDelay);
  const projectPathRef = useRef(projectPath);
  const activeFileRef = useRef(filePath);
  const jumpRef = useRef(onJumpToSymbol);
  const onGotoLineAppliedRef = useRef(onGotoLineApplied);
  const changeMarkersRef = useRef(changeMarkers);
  const blameLookupRef = useRef<(line: number) => void>(() => {});
  const blameHunkRef = useRef<(line: number) => void>(() => {});
  onChangeRef.current = onChange;
  onCountRef.current = onConflictCountChange;
  onFontDeltaRef.current = onFontSizeDelta;
  referenceEnabledRef.current = referenceEnabled;
  projectPathRef.current = projectPath;
  activeFileRef.current = filePath;
  jumpRef.current = onJumpToSymbol;
  onGotoLineAppliedRef.current = onGotoLineApplied;
  changeMarkersRef.current = changeMarkers;
  blameEnabledRef.current = Boolean(blameEnabled);
  blameBlockedRef.current = Boolean(blameBlocked);
  blameHoverDelayRef.current = blameHoverDelay;

  blameLookupRef.current = (line: number) => {
    const view = viewRef.current;
    if (!view) return;
    // 未保存修改时编辑器行号与磁盘行号已经错位，查到的会是别的行。
    // 不做行号映射（要跟踪每一处编辑，代价过高），直接提示保存后再看。
    if (blameBlockedRef.current) {
      const shown = view.state.field(blameField, false);
      if (shown && shown.line === line && shown.status === 'blocked') {
        view.dispatch({ effects: [setBlame.of(null), setBlameHover.of(false)] });
        return;
      }
      view.dispatch({
        effects: [
          setBlame.of({ line, status: 'blocked', info: null, hunk: null, hunkPending: false }),
          setBlameHover.of(false),
        ],
      });
      return;
    }
    const current = view.state.field(blameField, false);
    // 点同一行再次点击就收起；loading 中也允许，否则用户会以为点了没反应。
    // 收起后旧请求的结果会被下面的 latest.line 检查挡掉，不会贴回来。
    if (current && current.line === line) {
      view.dispatch({ effects: [setBlame.of(null), setBlameHover.of(false)] });
      return;
    }
    view.dispatch({
      effects: [
        setBlame.of({ line, status: 'loading', info: null, hunk: null, hunkPending: false }),
        setBlameHover.of(false),
      ],
    });

    const file = activeFileRef.current;
    void lookupBlame(projectPathRef.current, file, line).then((info) => {
      // 切文件会重建视图，旧请求的结果不能再往新文档上贴
      if (viewRef.current !== view) return;
      const latest = view.state.field(blameField, false);
      if (!latest || latest.line !== line) return;
      if (!info) {
        view.dispatch({
          effects: setBlame.of({ line, status: 'failed', info: null, hunk: null, hunkPending: false }),
        });
        return;
      }
      // 先只贴上 blame 结果把行内小字显示出来，diff 片段等悬停时再取。
      view.dispatch({
        effects: setBlame.of({ line, status: 'ready', info, hunk: null, hunkPending: true }),
      });
    });
  };

  // 悬停展开卡片时才去取该提交对本文件的 diff 片段
  blameHunkRef.current = (line: number) => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.field(blameField, false);
    if (!current || current.line !== line || !current.info || !current.hunkPending) return;
    const file = activeFileRef.current;
    const info = current.info;
    void lookupCommitFileDiff(projectPathRef.current, info.hash, file).then((patch) => {
      if (viewRef.current !== view) return;
      const latest = view.state.field(blameField, false);
      if (!latest || latest.line !== line || latest.info?.hash !== info.hash) return;
      view.dispatch({
        effects: setBlame.of({
          ...latest,
          hunk: pickHunkForLine(patch, info.origLine),
          hunkPending: false,
        }),
      });
    });
  };

  // 空白窗口另存为只换路径、不换文件：编辑器实例与撤销栈必须保留。
  // 重建 effect 的依赖里有 filePath，正常切文件要重建（各文件自带撤销历史），
  // 但 untitled://N → 真实路径 是同一次编辑的落盘，不能重建。
  // 这个标记必须在 render 阶段算好：React 会先跑上一次 effect 的清理，
  // 清理函数只能通过 ref 知道「这次变化要不要保留实例」。
  const viewPathRef = useRef(filePath);
  const preserveViewRef = useRef(false);
  if (viewPathRef.current !== filePath) {
    preserveViewRef.current =
      isUntitledPath(viewPathRef.current) && !isUntitledPath(filePath);
    viewPathRef.current = filePath;
  }

  const referenceExtensionOption = () =>
    referenceExtension({
      isEnabled: () => referenceEnabledRef.current,
      lookup: async (name, receiver, line) => {
        const result = await lookupSymbol(projectPathRef.current, name, {
          currentPath: activeFileRef.current,
          receiver,
          line,
        });
        return {
          name,
          loading: false,
          truncated: result.truncated,
          matches: result.matches,
          failed: !result.ok,
        };
      },
      onJump: (match) => jumpRef.current(match),
    });

  // 只在 filePath 变化时重建，避免每次按键都销毁编辑器。
  // readOnly 走 Compartment（见下方 effect），不参与重建：保留撤销栈。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // 空白窗口另存为：内容与撤销栈都属于同一次编辑，只把语言扩展换到新路径。
    // 上一次 effect 的清理函数已经根据 preserveViewRef 跳过了销毁。
    if (preserveViewRef.current) {
      preserveViewRef.current = false;
      const kept = viewRef.current;
      if (!kept) return;
      // 保留实例时文件可能换了（例如「在编辑器中打开」顶替未触碰的空白页签），
      // 只读状态不能沿用旧文档的，否则只读文件会变成可编辑。
      kept.dispatch({
        effects: readOnlyRef.current.reconfigure(EditorState.readOnly.of(readOnly)),
      });
      let disposed = false;
      void languageFor(filePath).then((extension) => {
        if (disposed || viewRef.current !== kept) return;
        kept.dispatch({ effects: languageRef.current.reconfigure(extension ?? []) });
      });
      return () => {
        disposed = true;
        if (preserveViewRef.current) return;
        kept.destroy();
        viewRef.current = null;
      };
    }

    let disposed = false;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          displayRef.current.of(
            displayExtensions({
              showLineNumbers,
              highlightActiveLine,
              bracketMatching,
              showWhitespace,
            }),
          ),
          appearanceRef.current.of(
            editorAppearanceExtension({ fontSize, lineHeight, fontFamily }),
          ),
          history(),
          highlightSelectionMatches(),
          // 自定义键位放在 searchKeymap 之前：CodeMirror 按顺序匹配，
          // 先命中的生效。否则 Ctrl+G 会被 searchKeymap 的「查找下一个」抢走。
          keysRef.current.of(bindingsExtension(keybindings)),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap]),
          changeKeymap,
          indentRef.current.of([
            EditorState.tabSize.of(tabSize),
            indentUnit.of(indentWithSpaces ? ' '.repeat(tabSize) : '\t'),
          ]),
          searchPhrases,
          wrapRef.current.of(wordWrap ? EditorView.lineWrapping : []),
          themeRef.current.of(themeExtensions(themeMode)),
          conflictField,
          changeMarkerField,
          changeGutter,
          // 折叠箭头放在变更色条之后，紧贴代码；关掉行号时它仍要在，
          // 所以不能塞进 displayExtensions 的 Compartment。
          foldGutter(),
          middleClickSelection,
          languageRef.current.of([]),
          diagnosticsRef.current.of([]),
          referenceRef.current.of(referenceExtensionOption()),
          blameRef.current.of(
            blameExtension({
              isEnabled: () => blameEnabledRef.current,
              hoverDelay: () => blameHoverDelayRef.current,
              onLineClick: (line) => blameLookupRef.current(line),
              requestHunk: (line) => blameHunkRef.current(line),
            }),
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
              onCountRef.current?.(parseConflicts(update.state.doc.toString()).length);
            }
          }),
          readOnlyRef.current.of(EditorState.readOnly.of(readOnly)),
        ],
      }),
    });
    viewRef.current = view;
    // 首次创建时补一次：effect 依赖相同引用时不会重跑
    view.dispatch({ effects: setChangeMarkers.of(changeMarkersRef.current ?? null) });
    onCountRef.current?.(parseConflicts(value).length);

    void languageFor(filePath).then((extension) => {
      if (disposed || !extension) return;
      view.dispatch({
        effects: languageRef.current.reconfigure(extension),
      });
    });

    return () => {
      disposed = true;
      // 下一次变化是空白窗口另存为：保留实例与撤销历史
      if (preserveViewRef.current) return;
      view.destroy();
      viewRef.current = null;
    };
    // value 故意不放进依赖：由外部内容变化通过下方 effect 同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setChangeMarkers.of(changeMarkers ?? null) });
  }, [changeMarkers]);

  // 只读状态变化只重配这一扩展，不重建编辑器。
  // readOnly 必须在 Compartment 里：保留实例的路径（空白窗口另存为、
  // 「在编辑器中打开」顶替空白页签）不会重建视图，只能靠 reconfigure 应用。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.readOnly === readOnly) return;
    view.dispatch({
      effects: readOnlyRef.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  // 主题切换只重配主题扩展，不重建编辑器
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeRef.current.reconfigure(themeExtensions(themeMode)),
    });
  }, [themeMode]);

  // 自动换行同理：只重配这一个扩展
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wrapRef.current.reconfigure(wordWrap ? EditorView.lineWrapping : []),
    });
    requestAnimationFrame(() => view.requestMeasure());
  }, [wordWrap]);

  // 缩进设置变化时重配，不需要重建编辑器
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: indentRef.current.reconfigure([
        EditorState.tabSize.of(tabSize),
        indentUnit.of(indentWithSpaces ? ' '.repeat(tabSize) : '\t'),
      ]),
    });
  }, [tabSize, indentWithSpaces]);

  // 快捷键变化时整体重配 keymap
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: keysRef.current.reconfigure(bindingsExtension(keybindings)),
    });
  }, [keybindings]);

  // 外观变化只重配主题扩展，不重建编辑器
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: appearanceRef.current.reconfigure(
        editorAppearanceExtension({ fontSize, lineHeight, fontFamily }),
      ),
    });
    requestAnimationFrame(() => view.requestMeasure());
  }, [fontSize, lineHeight, fontFamily]);

  // 显示开关同理：行号、高亮当前行、括号匹配、空白字符
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: displayRef.current.reconfigure(
        displayExtensions({ showLineNumbers, highlightActiveLine, bracketMatching, showWhitespace }),
      ),
    });
    requestAnimationFrame(() => view.requestMeasure());
  }, [showLineNumbers, highlightActiveLine, bracketMatching, showWhitespace]);

  // 诊断：只有文件语言命中已启用模块时才挂 linter。
  // diagnosticModule 由上层从 enabledModules 算好（稳定引用），这里不直接依赖数组，
  // 否则父组件每次渲染的新数组都会让 effect 反复 reconfigure。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (!diagnosticModule) {
      view.dispatch({ effects: diagnosticsRef.current.reconfigure([]) });
      return;
    }
    const lang = filePath.split('.').pop()?.toLowerCase() || '';
    const extension = [
      // lintGutter 负责渲染左侧的 .cm-lint-marker，linter 负责正文里的波浪线。
      linter(
        async (target) => {
          try {
            const { runDiagnose } = await import('../modules/registry');
            const found = await runDiagnose(diagnosticModule, target.state.sliceDoc(), lang);
            const max = target.state.doc.length;
            return found.map((item) => ({
              from: Math.min(item.from, max),
              to: Math.min(item.to, max),
              severity: item.severity,
              message: item.message,
            }));
          } catch (error) {
            // 解析器加载失败或内部异常时返回空结果：
            // 诊断是辅助功能，不能因为一次解析失败让整个编辑器不可用
            console.error('[diagnostics] 诊断失败', error);
            return [];
          }
        },
        { delay: 500 },
      ),
      lintGutter(),
    ];
    view.dispatch({ effects: diagnosticsRef.current.reconfigure(extension) });
    // readOnly 已移出重建依赖，切换文件时 filePath 一定会变、这里照样重跑。
  }, [filePath, diagnosticModule]);

  // 符号跳转的总开关变化时，只重配这一块扩展
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: referenceRef.current.reconfigure(referenceExtensionOption()),
    });
    // 模块关闭后已显示的卡片不能留在屏幕上
    if (!referenceEnabled) {
      view.dispatch({ effects: setCard.of(null) });
    }
    // referenceExtensionOption 只读 ref，依赖里不需要带上它
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referenceEnabled]);

  // 变成不可用过 blame 时（例如另存为后又被标成只读），已显示的卡片不能留着
  useEffect(() => {
    const view = viewRef.current;
    if (!view || blameEnabled) return;
    if (!view.state.field(blameField, false)) return;
    view.dispatch({ effects: [setBlame.of(null), setBlameHover.of(false)] });
  }, [blameEnabled]);

  // 只在 gotoLine 从 null 变成数字时定位一次；filePath 变化不应重复触发，
  // 否则上层忘记复位时切文件会误滚到同号行并抢焦点。
  const prevGotoLineRef = useRef<number | null>(null);
  useEffect(() => {
    if (gotoLine === null) {
      prevGotoLineRef.current = null;
      return;
    }
    if (prevGotoLineRef.current !== null) return;
    const view = viewRef.current;
    if (!view) return;
    prevGotoLineRef.current = gotoLine;
    const clamped = Math.min(Math.max(gotoLine, 1), view.state.doc.lines);
    const line = view.state.doc.line(clamped);
    const target = line.from;
    // 推迟到下一帧再 dispatch：跳转通常由卡片上的按钮点击触发，
    // 那一刻编辑器可能正处在自己的更新循环里，同步 dispatch 会抛
    // 「Calls to EditorView.update are not allowed while an update is in progress」，
    // React 19 没有 ErrorBoundary 会因此把整棵树卸载，表现为窗口白屏。
    const frame = requestAnimationFrame(() => {
      if (viewRef.current !== view) return;
      view.dispatch({
        selection: { anchor: target },
        effects: EditorView.scrollIntoView(target, { y: 'center' }),
      });
      view.focus();
      onGotoLineAppliedRef.current();
    });
    return () => cancelAnimationFrame(frame);
  }, [gotoLine, filePath]);

  // Ctrl + 滚轮调整字号，与终端行为一致（TerminalPane 用的是同一套判定）。
  // passive 必须为 false，否则 preventDefault 无效，Chromium 会连带缩放整页。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      // 纯横向的 Ctrl+手势（触控板横扫）deltaY 为 0，不能当成缩小
      if (event.deltaY === 0) return;
      onFontDeltaRef.current?.(event.deltaY < 0 ? 1 : -1);
    };
    host.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => host.removeEventListener('wheel', onWheel, { capture: true });
  }, []);

  // 文件内容被外部替换（如重新加载）时，同步到编辑器
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    // 程序性的整篇替换（加载文件）不进撤销栈，
    // 否则会和用户紧接着的编辑合并成同一个历史事件，一次撤销清空整篇内容。
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      annotations: Transaction.addToHistory.of(false),
    });
    onCountRef.current?.(parseConflicts(value).length);
  }, [value]);

  return <div className="codemirror-host" ref={hostRef} />;
}
