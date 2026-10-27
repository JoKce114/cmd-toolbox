const ACCENTS = ['#5b6cff', '#0891b2', '#0e9f6e', '#d97706', '#8b5cf6', '#db4b78', '#2563eb', '#0d9488'];

export const GLOBAL_COLOR = '#17181c';

export function accentFor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return ACCENTS[hash % ACCENTS.length];
}

export function tint(color: string, alpha: string): string {
  return `${color}${alpha}`;
}

export function defaultTabTitle(shellLabel: string): string {
  return shellLabel;
}

export type TerminalThemeMode = 'dark' | 'light';

export const terminalThemes = {
  dark: {
    background: '#0c0c0c',
    foreground: '#cccccc',
    cursor: '#ffffff',
    cursorAccent: '#0c0c0c',
    selectionBackground: '#264f78',
    selectionForeground: '#ffffff',
    scrollbarSliderBackground: '#3a3d45',
    scrollbarSliderHoverBackground: '#4c505a',
    scrollbarSliderActiveBackground: '#5a5f6a',
    black: '#0c0c0c',
    red: '#c50f1f',
    green: '#13a10e',
    yellow: '#c19c00',
    blue: '#0037da',
    magenta: '#881798',
    cyan: '#3a96dd',
    white: '#cccccc',
    brightBlack: '#767676',
    brightRed: '#e74856',
    brightGreen: '#16c60c',
    brightYellow: '#f9f1a5',
    brightBlue: '#3b78ff',
    brightMagenta: '#b4009e',
    brightCyan: '#61d6d6',
    brightWhite: '#f2f2f2',
  },
  light: {
    background: '#ffffff',
    foreground: '#24262b',
    cursor: '#1f2126',
    cursorAccent: '#ffffff',
    selectionBackground: '#dbe4ff',
    selectionForeground: '#1f2126',
    scrollbarSliderBackground: '#d7d8de',
    scrollbarSliderHoverBackground: '#c3c5cc',
    scrollbarSliderActiveBackground: '#b3b5bd',
    black: '#24262b',
    red: '#c93c37',
    green: '#1a7f48',
    yellow: '#9a6700',
    blue: '#2563eb',
    magenta: '#8250df',
    cyan: '#0d7d86',
    white: '#6e7480',
    brightBlack: '#8a909b',
    brightRed: '#e5534b',
    brightGreen: '#2da44e',
    brightYellow: '#bf8700',
    brightBlue: '#3b82f6',
    brightMagenta: '#a475f9',
    brightCyan: '#1f9aa8',
    brightWhite: '#b3b8c2',
  },
} as const;

