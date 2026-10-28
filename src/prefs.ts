export type AppPrefs = {
  fontSize: number;
  copyOnSelect: boolean;
  editorWordWrap: boolean;
};

const STORAGE_KEY = 'cmd-toolbox.prefs';

export function defaultPrefs(): AppPrefs {
  return { fontSize: 13, copyOnSelect: true, editorWordWrap: true };
}

export function readPrefs(): AppPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPrefs();
    const parsed = JSON.parse(raw) as Partial<AppPrefs>;
    const fontSize = Math.min(20, Math.max(11, Number(parsed.fontSize) || 13));
    return {
      fontSize,
      copyOnSelect: parsed.copyOnSelect !== false,
      editorWordWrap: parsed.editorWordWrap !== false,
    };
  } catch {
    return defaultPrefs();
  }
}

export function writePrefs(prefs: AppPrefs): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}
