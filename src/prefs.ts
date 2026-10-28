import { DEFAULT_KEYBINDINGS, normalizeCombo } from './editorKeymap';
import type { EditorActionId, KeyBindingMap } from './editorKeymap';

export type AppPrefs = {
  fontSize: number;
  copyOnSelect: boolean;
  editorWordWrap: boolean;
  editorTabSize: number;
  editorIndentWithSpaces: boolean;
  editorKeybindings: KeyBindingMap;
};

const STORAGE_KEY = 'cmd-toolbox.prefs';

export function defaultPrefs(): AppPrefs {
  return {
    fontSize: 13,
    copyOnSelect: true,
    editorWordWrap: true,
    editorTabSize: 4,
    editorIndentWithSpaces: false,
    editorKeybindings: { ...DEFAULT_KEYBINDINGS },
  };
}

function normalizeKeybindings(value: unknown): KeyBindingMap {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const result = { ...DEFAULT_KEYBINDINGS };
  for (const action of Object.keys(DEFAULT_KEYBINDINGS) as EditorActionId[]) {
    const raw = source[action];
    if (typeof raw === 'string' && raw.trim()) {
      result[action] = normalizeCombo(raw.trim());
    }
  }
  return result;
}

export function readPrefs(): AppPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPrefs();
    const parsed = JSON.parse(raw) as Partial<AppPrefs>;
    const fontSize = Math.min(20, Math.max(11, Number(parsed.fontSize) || 13));
    const tabSize = Math.min(8, Math.max(1, Number(parsed.editorTabSize) || 4));
    return {
      fontSize,
      copyOnSelect: parsed.copyOnSelect !== false,
      editorWordWrap: parsed.editorWordWrap !== false,
      editorTabSize: tabSize,
      // 默认使用制表符；只有明确存过 true 才用空格
      editorIndentWithSpaces: parsed.editorIndentWithSpaces === true,
      editorKeybindings: normalizeKeybindings(parsed.editorKeybindings),
    };
  } catch {
    return defaultPrefs();
  }
}

export function writePrefs(prefs: AppPrefs): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}
