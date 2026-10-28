import { useEffect, useRef } from 'react';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  Decoration,
  WidgetType,
} from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { EditorState, Compartment, StateField, RangeSetBuilder, Transaction } from '@codemirror/state';
import type { EditorState as EditorStateType } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { bindingsExtension } from '../editorKeymap';
import type { KeyBindingMap } from '../editorKeymap';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { createRoot } from 'react-dom/client';
import { languageFor } from '../editorLanguage';
import { searchPhrases } from '../editorSearchPhrases';
import { themeExtensions } from '../editorTheme';
import type { TerminalThemeMode } from '../theme';
import { parseConflicts, resolveConflict } from '../conflictParser';
import type { ConflictBlock, ConflictChoice } from '../conflictParser';
import { ConflictBar } from './ConflictBar';

export type CodeMirrorHostProps = {
  value: string;
  filePath: string;
  readOnly: boolean;
  themeMode: TerminalThemeMode;
  wordWrap: boolean;
  tabSize: number;
  indentWithSpaces: boolean;
  keybindings: KeyBindingMap;
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
  const onChangeRef = useRef(onChange);
  const onCountRef = useRef(onConflictCountChange);
  onChangeRef.current = onChange;
  onCountRef.current = onConflictCountChange;

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
