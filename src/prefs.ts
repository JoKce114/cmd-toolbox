import { DEFAULT_KEYBINDINGS, normalizeCombo } from './editorKeymap';
import type { EditorActionId, KeyBindingMap } from './editorKeymap';
import {
  DEFAULT_ENABLED_MODULES,
  LEGACY_DEFAULT_ENABLED_MODULES,
  mergeDefaultModules,
} from './modules/catalog';

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
  // 点行号 / 点行内正文后是否查询该行的 Git 提交信息
  editorBlameEnabled: boolean;
  // 悬停在内联 blame 小字上多久才弹出卡片（毫秒）
  editorBlameHoverDelay: number;
  editorTabSize: number;
  editorIndentWithSpaces: boolean;
  editorKeybindings: KeyBindingMap;
  enabledModules: string[];
  // 已经自动合并过的默认模块。持久化后，用户手动关掉的默认模块
  // 在下次启动时不会被当成「新模块」重新打开。
  seenDefaultModules: string[];
};

export const TERMINAL_FONT_SIZE_MIN = 11;
export const TERMINAL_FONT_SIZE_MAX = 20;
export const EDITOR_FONT_SIZE_MIN = 11;
export const EDITOR_FONT_SIZE_MAX = 32;
export const EDITOR_LINE_HEIGHT_MIN = 1;
export const EDITOR_LINE_HEIGHT_MAX = 3;
// 悬停卡片延迟的可选值。0 表示立即弹出；滑动条只会取这几个档位，
// 避免存进任意数值后设置面板显示出一个奇怪的时间。
export const BLAME_HOVER_DELAY_OPTIONS = [0, 200, 500, 1000, 1500] as const;
export const BLAME_HOVER_DELAY_DEFAULT = 1500;

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
    editorBlameEnabled: true,
    editorBlameHoverDelay: BLAME_HOVER_DELAY_DEFAULT,
    editorTabSize: 4,
    editorIndentWithSpaces: false,
    editorKeybindings: { ...DEFAULT_KEYBINDINGS },
    enabledModules: [...DEFAULT_ENABLED_MODULES],
    seenDefaultModules: [...DEFAULT_ENABLED_MODULES],
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

// 只接受档位内（或档位附近）的值，存进别的数就吸附到最近的合法档位
function normalizeBlameHoverDelay(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return BLAME_HOVER_DELAY_DEFAULT;
  let best = BLAME_HOVER_DELAY_OPTIONS[0] as number;
  for (const option of BLAME_HOVER_DELAY_OPTIONS) {
    if (Math.abs(option - parsed) < Math.abs(best - parsed)) best = option;
  }
  return best;
}

function normalizeKeybindings(value: unknown): KeyBindingMap {  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
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
    // 老版本没有 seenDefaultModules。只把这一版新增的默认模块补进已启用列表，
    // 旧默认模块（如 diag-php）缺失时视为用户手动关闭，不重新打开。
    const storedModules = Array.isArray(parsed.enabledModules)
      ? parsed.enabledModules
      : null;
    const storedSeenDefaults = Array.isArray(parsed.seenDefaultModules)
      ? parsed.seenDefaultModules
      : null;
    const modules = mergeDefaultModules(
      (storedModules ?? DEFAULT_ENABLED_MODULES).filter(
        (id): id is string => typeof id === 'string',
      ),
      (
        storedSeenDefaults ??
        (storedModules ? LEGACY_DEFAULT_ENABLED_MODULES : DEFAULT_ENABLED_MODULES)
      ).filter((id): id is string => typeof id === 'string'),
    );
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
      editorBlameEnabled: parsed.editorBlameEnabled !== false,
      editorBlameHoverDelay: normalizeBlameHoverDelay(parsed.editorBlameHoverDelay),
      editorTabSize: clampInt(parsed.editorTabSize, 1, 8, 4),
      // 默认使用制表符；只有明确存过 true 才用空格
      editorIndentWithSpaces: parsed.editorIndentWithSpaces === true,
      editorKeybindings: normalizeKeybindings(parsed.editorKeybindings),
      // mergeDefaultModules 会丢弃未知 id，防止降级后残留脏数据
      enabledModules: modules.enabledModules,
      seenDefaultModules: modules.seenDefaultModules,
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
