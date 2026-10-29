import { DEFAULT_KEYBINDINGS, normalizeCombo } from './editorKeymap';
import type { EditorActionId, KeyBindingMap } from './editorKeymap';

export type EditorFontFamily = 'consolas' | 'courier' | 'lucida';

export type AppPrefs = {
  terminalFontSize: number;
  copyOnSelect: boolean;
  editorFontSize: number;
  editorLineHeight: number;
  editorFontFamily: EditorFontFamily;
  editorWordWrap: boolean;
  editorLineNumbers: boolean;
  editorHighlightActiveLine: boolean;
  editorBracketMatching: boolean;
  editorShowWhitespace: boolean;
  editorTabSize: number;
  editorIndentWithSpaces: boolean;
  editorKeybindings: KeyBindingMap;
};

export const TERMINAL_FONT_SIZE_MIN = 11;
export const TERMINAL_FONT_SIZE_MAX = 20;
export const EDITOR_FONT_SIZE_MIN = 11;
export const EDITOR_FONT_SIZE_MAX = 32;
export const EDITOR_LINE_HEIGHT_MIN = 1;
export const EDITOR_LINE_HEIGHT_MAX = 3;

// 链尾的中文字体不能删：Consolas 等字体没有中文字形，
// 中文注释靠微软雅黑兜底，删掉会让中文掉进别的字体、行高看起来会跳。
export const EDITOR_FONT_STACKS: Record<EditorFontFamily, string> = {
  consolas: 'Consolas, "Microsoft YaHei", monospace',
  courier: '"Courier New", "Microsoft YaHei", monospace',
  lucida: '"Lucida Console", "Microsoft YaHei", monospace',
};

const STORAGE_KEY = 'cmd-toolbox.prefs';

export function defaultPrefs(): AppPrefs {
  return {
    terminalFontSize: 13,
    copyOnSelect: true,
    editorFontSize: 13,
    editorLineHeight: 1.5,
    editorFontFamily: 'consolas',
    editorWordWrap: true,
    editorLineNumbers: true,
    editorHighlightActiveLine: true,
    editorBracketMatching: true,
    editorShowWhitespace: false,
    editorTabSize: 4,
    editorIndentWithSpaces: false,
    editorKeybindings: { ...DEFAULT_KEYBINDINGS },
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
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
    // 旧版本把终端字号存成 fontSize，升级后要能继续读到
    const parsed = JSON.parse(raw) as Partial<AppPrefs> & { fontSize?: number };
    const rawLineHeight = Number(parsed.editorLineHeight);
    // 0.05 步长的滑块会给 1.2000000000000002 这种值，必须舍入到两位小数
    const editorLineHeight = Number.isFinite(rawLineHeight)
      ? Math.min(
          EDITOR_LINE_HEIGHT_MAX,
          Math.max(EDITOR_LINE_HEIGHT_MIN, Math.round(rawLineHeight * 20) / 20),
        )
      : 1.5;
    const editorFontFamily: EditorFontFamily =
      parsed.editorFontFamily === 'courier' || parsed.editorFontFamily === 'lucida'
        ? parsed.editorFontFamily
        : 'consolas';
    return {
      terminalFontSize: clampInt(
        parsed.terminalFontSize ?? parsed.fontSize,
        TERMINAL_FONT_SIZE_MIN,
        TERMINAL_FONT_SIZE_MAX,
        13,
      ),
      copyOnSelect: parsed.copyOnSelect !== false,
      editorFontSize: clampInt(
        parsed.editorFontSize,
        EDITOR_FONT_SIZE_MIN,
        EDITOR_FONT_SIZE_MAX,
        13,
      ),
      editorLineHeight,
      editorFontFamily,
      editorWordWrap: parsed.editorWordWrap !== false,
      editorLineNumbers: parsed.editorLineNumbers !== false,
      editorHighlightActiveLine: parsed.editorHighlightActiveLine !== false,
      editorBracketMatching: parsed.editorBracketMatching !== false,
      editorShowWhitespace: parsed.editorShowWhitespace === true,
      editorTabSize: clampInt(parsed.editorTabSize, 1, 8, 4),
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
