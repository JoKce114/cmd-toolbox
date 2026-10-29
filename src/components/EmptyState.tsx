import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  FileCode2,
  FolderOpen,
  Pencil,
  SquareTerminal,
} from 'lucide-react';
import type { Group, ShellInfo } from '../types';

type EmptyStateProps = {
  group: Group;
  shells: ShellInfo[];
  defaultShell: ShellInfo | undefined;
  canChooseShell?: boolean;
  onNewTerminal: (shellId?: string) => void;
  onShellMenu: (event: ReactMouseEvent) => void;
  onReveal: () => void;
  onEditProject: () => void;
  onOpenEditor: () => void;
};

export function EmptyState({
  group,
  shells,
  defaultShell,
  canChooseShell = shells.length > 1,
  onNewTerminal,
  onShellMenu,
  onReveal,
  onEditProject,
  onOpenEditor,
}: EmptyStateProps) {
  const isGlobal = group.kind === 'global';

  return (
    <div className="empty-state">
      <div className="empty-halo">
        <div className="empty-icon">
          <SquareTerminal size={26} strokeWidth={1.6} />
        </div>
      </div>

      <h1 className="empty-title">
        {isGlobal ? '打开全局终端' : `在「${group.name}」中打开终端`}
      </h1>
      <p className="empty-desc">
        {group.exists
          ? isGlobal
            ? '从用户目录启动一个独立终端，适合全局脚本、临时命令和环境检查。'
            : '每个项目都可以同时打开多个终端，页签会按项目归组，随时切换不丢失现场。'
          : '这个项目的目录不存在或已经被移动。更新项目路径后，就可以在这里打开终端。'}
      </p>

      <div className={`empty-path${group.exists ? '' : ' invalid'}`} title={group.path}>
        <FolderOpen size={13} strokeWidth={1.8} />
        <span>{group.path || '尚未设置目录'}</span>
      </div>

      {!group.exists ? (
        <>
          <div className="empty-warning">
            <AlertTriangle size={14} />
            <span>找不到项目目录，请检查文件夹是否被移动或重命名。</span>
          </div>
          <div className="empty-actions">
            <button type="button" className="btn btn-primary" onClick={onEditProject}>
              <Pencil size={14} />
              编辑项目路径
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="empty-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onNewTerminal(defaultShell?.id)}
            >
              <SquareTerminal size={15} strokeWidth={1.8} />
              打开{defaultShell?.label || '命令提示符'}
            </button>
            {canChooseShell ? (
              <button type="button" className="btn btn-secondary" onClick={onShellMenu}>
                其他终端
                <ChevronDown size={13} />
              </button>
            ) : null}
            {!isGlobal ? (
              <button type="button" className="btn btn-secondary" onClick={onOpenEditor}>
                <FileCode2 size={14} strokeWidth={1.8} />
                打开编辑器
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost" onClick={onReveal}>
              <FolderOpen size={14} strokeWidth={1.8} />
              打开目录
            </button>
          </div>

          <div className="empty-hints">
            <span>
              <kbd>Ctrl</kbd>
              <span className="hint-plus">+</span>
              <kbd>T</kbd>
              <span className="hint-text">新建终端</span>
            </span>
            <span className="hint-dot" />
            <span>
              <kbd>Ctrl</kbd>
              <span className="hint-plus">+</span>
              <kbd>W</kbd>
              <span className="hint-text">关闭页签</span>
            </span>
            <span className="hint-dot" />
            <span className="hint-text">双击页签可重命名用途</span>
          </div>
        </>
      )}
    </div>
  );
}
