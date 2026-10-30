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
