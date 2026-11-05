import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, CornerLeftUp, File as FileIcon, Folder } from 'lucide-react';
import type { FileEntry } from '../types';

const MENU_WIDTH = 264;
const MENU_EDGE = 8;
// 超过这么多段就把中间折叠成「…」，否则长路径会把编辑器标题挤没
const COLLAPSE_THRESHOLD = 5;

type SegmentCrumb = {
  kind: 'segment';
  label: string;
  // 点这一段时打开的目录（它的父目录），这一段在里面高亮
  dir: string;
  fullPath: string;
  isFile: boolean;
};

type CollapsedCrumb = {
  kind: 'collapsed';
  dir: string;
  highlight: string;
};

type Crumb = SegmentCrumb | CollapsedCrumb;

type MenuState = {
  left: number;
  top: number;
  dir: string;
  highlight: string;
};

export type EditorBreadcrumbProps = {
  projectPath: string;
  relPath: string;
  onOpen: (relPath: string) => void;
};

function buildCrumbs(relPath: string): Crumb[] {
  const segments = relPath.split('/').filter(Boolean);
  const all: SegmentCrumb[] = segments.map((label, index) => ({
    kind: 'segment',
    label,
    dir: segments.slice(0, index).join('/'),
    fullPath: segments.slice(0, index + 1).join('/'),
    isFile: index === segments.length - 1,
  }));
  if (all.length <= COLLAPSE_THRESHOLD) return all;

  const hidden = all.slice(1, all.length - 3);
  return [
    all[0],
    { kind: 'collapsed', dir: hidden[0].dir, highlight: hidden[0].fullPath },
    ...all.slice(-3),
  ];
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((left, right) => {
    if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
    return left.name.localeCompare(right.name, 'zh-Hans-CN');
  });
}

export function EditorBreadcrumb({ projectPath, relPath, onOpen }: EditorBreadcrumbProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuDir = menu?.dir ?? null;

  // 目录内容只在菜单打开时读：刚在文件树里新建的文件立刻就能选到
  useEffect(() => {
    if (menuDir === null) return;
    let cancelled = false;
    setLoading(true);
    setEntries([]);
    window.api.files
      .list(projectPath, menuDir)
      .then((result) => {
        if (!cancelled) setEntries(sortEntries(result.entries));
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [menuDir, projectPath]);

  useEffect(() => {
    if (!menu) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.editor-breadcrumb')) return;
      setMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMenu(null);
    };
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  const openMenu = (
    event: React.MouseEvent<HTMLButtonElement>,
    dir: string,
    highlight: string,
  ) => {
    if (menu && menu.dir === dir && menu.highlight === highlight) {
      setMenu(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({
      left: Math.min(
        Math.max(MENU_EDGE, rect.left),
        Math.max(MENU_EDGE, window.innerWidth - MENU_WIDTH - MENU_EDGE),
      ),
      top: rect.bottom + 4,
      dir,
      highlight,
    });
  };

  const enterDir = (dir: string) => {
    setMenu((current) => (current ? { ...current, dir, highlight: dir } : current));
  };

  const goUp = () => {
    setMenu((current) => {
      if (!current || !current.dir) return current;
      return {
        ...current,
        dir: current.dir.split('/').slice(0, -1).join('/'),
        highlight: current.dir,
      };
    });
  };

  const chooseEntry = (entry: FileEntry) => {
    if (entry.isDir) {
      enterDir(entry.relPath);
      return;
    }
    onOpen(entry.relPath);
    setMenu(null);
  };

  const crumbs = buildCrumbs(relPath);

  return (
    <nav className="editor-breadcrumb" aria-label="文件路径">
      {crumbs.map((crumb, index) => {
        const separator =
          index > 0 ? (
            <span className="editor-breadcrumb-sep" aria-hidden="true">
              <ChevronRight size={11} />
            </span>
          ) : null;
        if (crumb.kind === 'collapsed') {
          return (
            <span className="editor-breadcrumb-slot" key="collapsed">
              {separator}
              <button
                type="button"
                className="editor-breadcrumb-seg"
                title="显示被省略的上级目录"
                onClick={(event) => openMenu(event, crumb.dir, crumb.highlight)}
              >
                <span className="editor-breadcrumb-label">…</span>
              </button>
            </span>
          );
        }
        return (
          <span className="editor-breadcrumb-slot" key={crumb.fullPath}>
            {separator}
            <button
              type="button"
              className={`editor-breadcrumb-seg${crumb.isFile ? ' is-file' : ''}`}
              title={crumb.fullPath}
              onClick={(event) => openMenu(event, crumb.dir, crumb.fullPath)}
            >
              <span className="editor-breadcrumb-label">{crumb.label}</span>
            </button>
          </span>
        );
      })}

      {menu ? (
        <div
          ref={menuRef}
          className="editor-breadcrumb-menu"
          style={{
            left: menu.left,
            top: menu.top,
            width: MENU_WIDTH,
            maxHeight: `calc(100vh - ${menu.top + MENU_EDGE}px)`,
          }}
          role="menu"
        >
          <div className="editor-breadcrumb-menu-head">
            {menu.dir ? (
              <button type="button" className="editor-breadcrumb-up" onClick={goUp}>
                <CornerLeftUp size={11} />
                上一级
              </button>
            ) : null}
            <span className="editor-breadcrumb-menu-path" title={menu.dir || projectPath}>
              {menu.dir ? `/${menu.dir}` : '项目根目录'}
            </span>
          </div>
          <div className="editor-breadcrumb-menu-list">
            {loading ? <p className="editor-breadcrumb-empty">加载中…</p> : null}
            {!loading && entries.length === 0 ? (
              <p className="editor-breadcrumb-empty">这个目录是空的</p>
            ) : null}
            {entries.map((entry) => {
              const current = entry.relPath === menu.highlight;
              return (
                <button
                  key={entry.relPath}
                  type="button"
                  role="menuitem"
                  className={`editor-breadcrumb-item${current ? ' is-current' : ''}${entry.isDir ? ' is-dir' : ''}`}
                  title={entry.relPath}
                  onClick={() => chooseEntry(entry)}
                >
                  {entry.isDir ? <Folder size={13} /> : <FileIcon size={13} />}
                  <span className="editor-breadcrumb-item-name">{entry.name}</span>
                  {current ? <Check size={12} className="editor-breadcrumb-check" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </nav>
  );
}
