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

// 记录用户「已经看过」的版本，决定下次启动弹不弹更新公告。
// 单独一个 key，不放进 AppPrefs，避免设置页保存时把它一起覆盖掉。
const SEEN_UPDATE_KEY = 'cmd-toolbox.seen-update';

export function readSeenVersion(): string | null {
  try {
    const raw = window.localStorage.getItem(SEEN_UPDATE_KEY);
    return raw && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

export function writeSeenVersion(version: string): void {
  try {
    window.localStorage.setItem(SEEN_UPDATE_KEY, version);
  } catch {
    // 存不进去只会导致下次多弹一次公告，不值得打断调用方
  }
}
