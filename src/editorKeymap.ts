import { keymap } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import {
  copyLineDown,
  copyLineUp,
  deleteCharBackward,
  deleteLine,
  indentLess,
  indentMore,
  moveLineDown,
  moveLineUp,
  toggleComment,
} from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { gotoLine, openSearchPanel } from '@codemirror/search';

export type EditorActionId =
  | 'indent'
  | 'outdent'
  | 'copyLineDown'
  | 'copyLineUp'
  | 'moveLineUp'
  | 'moveLineDown'
  | 'deleteLine'
  | 'toggleComment'
  | 'gotoLine';

export type KeyBindingMap = Record<EditorActionId, string>;

// 默认键位按 Trae / VS Code 的习惯来
export const DEFAULT_KEYBINDINGS: KeyBindingMap = {
  indent: 'Tab',
  outdent: 'Shift-Tab',
  copyLineDown: 'Shift-Alt-ArrowDown',
  copyLineUp: 'Shift-Alt-ArrowUp',
  moveLineUp: 'Alt-ArrowUp',
  moveLineDown: 'Alt-ArrowDown',
  deleteLine: 'Ctrl-Shift-k',
  toggleComment: 'Ctrl-/',
  gotoLine: 'Ctrl-g',
};

export const EDITOR_ACTION_LABEL: Record<EditorActionId, string> = {
  indent: '增加缩进',
  outdent: '减少缩进',
  copyLineDown: '向下复制行',
  copyLineUp: '向上复制行',
  moveLineUp: '上移当前行',
  moveLineDown: '下移当前行',
  deleteLine: '删除当前行',
  toggleComment: '切换注释',
  gotoLine: '跳转到行',
};

// 这些组合被应用自身占用，编辑器里不允许再绑定
export const RESERVED_BINDINGS: Array<{ combo: string; reason: string }> = [
  { combo: 'Ctrl-s', reason: '保存文件' },
  { combo: 'Ctrl-w', reason: '关闭页签' },
  { combo: 'Ctrl-f', reason: '文件内查找' },
  { combo: 'Ctrl-Shift-f', reason: '项目搜索' },
  { combo: 'Ctrl-t', reason: '新建终端' },
];

const ACTIONS: Record<EditorActionId, (view: EditorView) => boolean> = {
  indent: indentMore,
  outdent: indentLess,
  copyLineDown,
  copyLineUp,
  moveLineUp,
  moveLineDown,
  deleteLine,
  toggleComment,
  gotoLine,
};

// Trae / VS Code 的退格习惯：光标左边只有空白时，一次退掉一整级缩进，
// 而不是一个字符一个字符地删。
function smartBackspace(view: EditorView): boolean {
  const { state } = view;
  if (state.selection.ranges.length !== 1) return deleteCharBackward(view);
  const range = state.selection.main;
  if (!range.empty) return deleteCharBackward(view);

  const line = state.doc.lineAt(range.head);
  const before = state.sliceDoc(line.from, range.head);
  // 行首，或左边不全是空白：交给默认行为（合并行 / 删普通字符）
  if (!before || !/^[ \t]+$/.test(before)) return deleteCharBackward(view);

  const last = before.charAt(before.length - 1);
  let removeCount: number;
  if (last === '\t') {
    removeCount = 1;
  } else {
    const unit = state.facet(indentUnit);
    const width = unit === '\t' ? state.facet(EditorState.tabSize) : Math.max(1, unit.length);
    removeCount = ((before.length - 1) % width) + 1;
  }

  const from = range.head - removeCount;
  view.dispatch({
    changes: { from, to: range.head },
    selection: EditorSelection.cursor(from),
    userEvent: 'delete.backward',
  });
  return true;
}

export function normalizeCombo(combo: string): string {
  return combo
    .split('-')
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === 'ctrl' || lower === 'control') return 'Ctrl';
      if (lower === 'alt') return 'Alt';
      if (lower === 'shift') return 'Shift';
      if (lower === 'meta' || lower === 'cmd') return 'Meta';
      // CodeMirror 要求方向键写成 ArrowDown 这种驼峰形式，不能全小写
      if (lower.startsWith('arrow')) {
        const direction = lower.slice(5);
        return `Arrow${direction.charAt(0).toUpperCase()}${direction.slice(1)}`;
      }
      if (lower.length === 1) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('-');
}

export function bindingsExtension(bindings: KeyBindingMap): Extension {
  return keymap.of([
    // 缩进感知的退格放在最前，优先于 defaultKeymap 的普通删字符
    { key: 'Backspace', run: smartBackspace },
    ...(Object.keys(bindings) as EditorActionId[]).map((action) => ({
      key: bindings[action],
      run: ACTIONS[action],
      preventDefault: true,
    })),
  ]);
}

// Ctrl+F 仍然交给 CodeMirror 自己的查找面板
export const searchPanelBinding = keymap.of([
  { key: 'Mod-f', run: openSearchPanel, preventDefault: true },
]);
