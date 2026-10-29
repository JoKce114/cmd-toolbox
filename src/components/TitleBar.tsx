import { Moon, Settings, Sun } from 'lucide-react';
import { cn } from '../lib';
import { LogoMark } from './LogoMark';
import type { TerminalThemeMode } from '../theme';

type TitleBarProps = {
  themeMode: TerminalThemeMode;
  onThemeChange: (mode: TerminalThemeMode) => void;
  updateAvailable?: boolean;
  onOpenSettings: () => void;
};

export function TitleBar({
  themeMode,
  onThemeChange,
  updateAvailable = false,
  onOpenSettings,
}: TitleBarProps) {
  return (
    <header className="titlebar">
      <LogoMark size={20} />
      <span className="brand-name">Cmd Toolbox</span>
      <span className="brand-divider" aria-hidden="true" />
      <span className="brand-tagline">本地项目终端</span>
      <div className="titlebar-actions">
        <button
          type="button"
          className="titlebar-settings"
          title={updateAvailable ? '设置 · 有新版本' : '设置'}
          onClick={onOpenSettings}
        >
          <Settings size={14} />
          {updateAvailable ? <span className="titlebar-update-dot" aria-hidden="true" /> : null}
        </button>
        <div className="theme-switch" role="group" aria-label="终端配色">
          <button
            type="button"
            className={cn('theme-option', themeMode === 'light' && 'active')}
            aria-pressed={themeMode === 'light'}
            title="浅色终端"
            onClick={() => onThemeChange('light')}
          >
            <Sun size={12} strokeWidth={1.9} />
            <span>浅色</span>
          </button>
          <button
            type="button"
            className={cn('theme-option', themeMode === 'dark' && 'active')}
            aria-pressed={themeMode === 'dark'}
            title="深色终端"
            onClick={() => onThemeChange('dark')}
          >
            <Moon size={12} strokeWidth={1.9} />
            <span>深色</span>
          </button>
        </div>
      </div>
    </header>
  );
}
