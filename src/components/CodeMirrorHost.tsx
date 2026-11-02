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
} from '@codemirror/view';
import type { DecorationSet, Tooltip } from '@codemirror/view';
import {
  EditorState,
  Compartment,
  StateField,
  StateEffect,
  RangeSetBuilder,
  Transaction,
} from '@codemirror/state';
import type { EditorState as EditorStateType, Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching as bracketMatchingExtension, indentUnit } from '@codemirror/language';
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
  // 定位完成后通知上层把 gotoLine 复位为 null，避免切文件时再次误滚
  onGotoLineApplied?: () => void;
  onFontSizeDelta?: (delta: number) => void;
  onChange: (value: string) => void;
  onConflictCountChange?: (count: number) => void;
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

function referenceExtension(options: {
  isEnabled: () => boolean;
  lookup: (name: string, receiver: string) => Promise<SymbolCardState>;
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
      view.dispatch({
        effects: setCard.of({
          pos: word.from,
          card: { name: word.name, loading: true, truncated: false, matches: [], failed: false },
          seq,
        }),
      });

      void options.lookup(word.name, word.receiver).then((card) => {
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
  const onChangeRef = useRef(onChange);
  const onCountRef = useRef(onConflictCountChange);
  const onFontDeltaRef = useRef(onFontSizeDelta);
  const referenceEnabledRef = useRef(referenceEnabled);
  const projectPathRef = useRef(projectPath);
  const activeFileRef = useRef(filePath);
  const jumpRef = useRef(onJumpToSymbol);
  const onGotoLineAppliedRef = useRef(onGotoLineApplied);
  onChangeRef.current = onChange;
  onCountRef.current = onConflictCountChange;
  onFontDeltaRef.current = onFontSizeDelta;
  referenceEnabledRef.current = referenceEnabled;
  projectPathRef.current = projectPath;
  activeFileRef.current = filePath;
  jumpRef.current = onJumpToSymbol;
  onGotoLineAppliedRef.current = onGotoLineApplied;

  const referenceExtensionOption = () =>
    referenceExtension({
      isEnabled: () => referenceEnabledRef.current,
      lookup: async (name, receiver) => {
        const result = await lookupSymbol(projectPathRef.current, name, {
          currentPath: activeFileRef.current,
          receiver,
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
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          indentRef.current.of([
            EditorState.tabSize.of(tabSize),
            indentUnit.of(indentWithSpaces ? ' '.repeat(tabSize) : '\t'),
          ]),
          searchPhrases,
          wrapRef.current.of(wordWrap ? EditorView.lineWrapping : []),
          themeRef.current.of(themeExtensions(themeMode)),
          conflictField,
          languageRef.current.of([]),
          diagnosticsRef.current.of([]),
          referenceRef.current.of(referenceExtensionOption()),
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
    // readOnly 变化会重建整个 EditorView（见上方重建 effect），新视图里的
    // diagnosticsRef 是空的，这里必须跟着重跑，否则诊断会静默消失到下次切文件。
  }, [filePath, readOnly, diagnosticModule]);

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
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
    view.focus();
    onGotoLineAppliedRef.current?.();
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
