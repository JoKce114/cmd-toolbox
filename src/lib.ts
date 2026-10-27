export function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return '出现未知错误，请稍后重试';
}

export function folderNameFromPath(value: string): string {
  const normalized = value.trim().replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  const last = parts[parts.length - 1] || '';
  if (/^[a-zA-Z]:$/.test(last)) return `${last[0].toUpperCase()} 盘`;
  return last || normalized;
}

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function moveById<T>(
  list: T[],
  fromId: string,
  toId: string,
  position: 'before' | 'after',
  getId: (item: T) => string,
): T[] | null {
  if (!fromId || !toId || fromId === toId) return null;
  const fromIndex = list.findIndex((item) => getId(item) === fromId);
  if (fromIndex < 0) return null;
  const next = list.filter((item) => getId(item) !== fromId);
  let insertIndex = next.findIndex((item) => getId(item) === toId);
  if (insertIndex < 0) return null;
  if (position === 'after') insertIndex += 1;
  next.splice(insertIndex, 0, list[fromIndex]);
  return next;
}

export function normalizeHttpUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  const withProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function nextPaneNo(paneNos: number[]): number {
  let maximum = 0;
  for (const value of paneNos) {
    const number = Number(value) || 0;
    if (number > maximum) maximum = number;
  }
  return maximum + 1;
}

export function quoteTerminalPath(value: string): string {
  const filePath = value.trim();
  if (!filePath) return '';
  if (!/[\s&()[\]{}^=;,'!]/.test(filePath)) return filePath;
  return `"${filePath.replace(/"/g, '\\"')}"`;
}

export function formatDroppedPaths(paths: string[]): string {
  return paths.map(quoteTerminalPath).filter(Boolean).join('\r');
}

export function shellShortLabel(shellId: string): string {
  if (shellId === 'cmd') return 'CMD';
  if (shellId === 'powershell') return 'PS';
  if (shellId === 'gitbash') return 'BASH';
  if (shellId === 'grok') return 'GROK';
  if (shellId === 'codex') return 'CODEX';
  if (shellId === 'claude') return 'CLAUDE';
  if (shellId === 'gemini') return 'GEMINI';
  if (shellId === 'opencode') return 'OPEN';
  if (shellId === 'browser') return 'WEB';
  return 'TERM';
}
