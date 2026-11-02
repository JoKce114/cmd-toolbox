import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  ChevronRight,
  ChevronsDownUp,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
} from 'lucide-react';
import { cn, toErrorMessage } from '../lib';
import type { FileEntry, Group, MenuState } from '../types';
import { PopupMenu } from './PopupMenu';
import { minifiedName } from '../modules/minify';

type FileTreeProps = {
  group: Group;
  activePath: string;
  onOpen: (relPath: string) => void;
  onMinify: (relPath: string) => void;
  canMinify: (relPath: string) => boolean;
  onError: (message: string) => void;
};

type DirState = Record<string, FileEntry[] | undefined>;

// Trae / VS Code 风格的自然排序：
// 目录在前，然后按名称比较，名称里的数字段按数值比较
// （1, 2, 10 而不是 1, 10, 2）。
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return collator.compare(a.name, b.name);
}

function ancestorsOf(relPath: string): string[] {
  const parts = relPath.split('/');
  parts.pop();
  const result: string[] = [''];
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    result.push(current);
  }
  return result;
}

export function FileTree({
  group,
  activePath,
  onOpen,
  onMinify,
  canMinify,
  onError,
}: FileTreeProps) {
  const [children, setChildren] = useState<DirState>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [menu, setMenu] = useState<MenuState | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingRevealRef = useRef('');

  const loadDir = useCallback(
    async (relDir: string) => {
      try {
        const result = await window.api.files.list(group.path, relDir);
        setChildren((previous) => ({ ...previous, [relDir]: result.entries }));
        return result.entries;
      } catch (error) {
        onError(toErrorMessage(error));
        return [];
      }
    },
    [group.path, onError],
  );

  // 刷新：重新列所有已展开的目录。文件在外部被增删时用它同步。
  const reloadAll = useCallback(async () => {
    const dirs = Array.from(expanded);
    setChildren({});
    await Promise.all(dirs.map((dir) => loadDir(dir)));
  }, [expanded, loadDir]);

  const collapseAll = useCallback(() => {
    setExpanded(new Set(['']));
  }, []);

  // 新建按钮的落点：activePath 是当前打开的文件，新建条目与它同级；
  // 没有打开文件时落在项目根目录。
  const createTargetDir = useCallback(() => {
    if (!activePath) return '';
    return ancestorsOf(activePath).pop() || '';
  }, [activePath]);

  const createFile = useCallback(
    async (relDir: string) => {
      const relPath = await promptName('新建文件', relDir, '');
      if (!relPath) return;
      try {
        await window.api.files.createFile(group.path, relPath, '');
        await loadDir(relDir);
        setExpanded((previous) => new Set(previous).add(relDir));
        onOpen(relPath);
      } catch (error) {
        onError(toErrorMessage(error));
      }
    },
    [group.path, loadDir, onError, onOpen],
  );

  const createFolder = useCallback(
    async (relDir: string) => {
      const relPath = await promptName('新建文件夹', relDir, '');
      if (!relPath) return;
      try {
        await window.api.files.createDir(group.path, relPath);
        await loadDir(relDir);
        setExpanded((previous) => new Set(previous).add(relDir));
      } catch (error) {
        onError(toErrorMessage(error));
      }
    },
    [group.path, loadDir, onError],
  );

  useEffect(() => {
    setChildren({});
    setExpanded(new Set(['']));
    void loadDir('');
  }, [group.key, loadDir]);

  // 打开深层文件时，把沿途目录逐层展开，让它在树里可见。
  useEffect(() => {
    if (!activePath) return;
    const dirs = ancestorsOf(activePath);
    if (dirs.length <= 1) return;

    let cancelled = false;
    setExpanded((previous) => {
      const next = new Set(previous);
      dirs.forEach((dir) => next.add(dir));
      return next;
    });
    pendingRevealRef.current = activePath;

    void (async () => {
      for (const dir of dirs) {
        if (cancelled) return;
        if (children[dir]) continue;
        await loadDir(dir);
      }
    })();

    return () => {
      cancelled = true;
    };
    // children 故意不放进依赖：只要 activePath 变化触发一次即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, loadDir]);

  // 展开完成后把对应行滚到可视区
  useEffect(() => {
    const target = pendingRevealRef.current;
    if (!target) return;
    const row = rowRefs.current.get(target);
    if (!row) return;
    pendingRevealRef.current = '';
    row.scrollIntoView({ block: 'center' });
  }, [children, activePath]);

  const toggle = (relPath: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(relPath)) next.delete(relPath);
      else {
        next.add(relPath);
        if (!children[relPath]) void loadDir(relPath);
      }
      return next;
    });
  };

  const openRowMenu = (event: React.MouseEvent, entry: FileEntry) => {
    if (entry.isDir || !canMinify(entry.relPath)) return;
    event.preventDefault();
    event.stopPropagation();
    // 目标名与实际写入路径用同一个函数算，避免菜单文案和产物不一致
    const target = minifiedName(entry.relPath);
    const name = target.split('/').pop() || target;
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          type: 'item',
          id: 'file-minify',
          label: `生成 ${name}`,
          onSelect: () => onMinify(entry.relPath),
        },
      ],
    });
  };

  const renderDir = (relDir: string, depth: number): ReactElement[] => {
    const entries = [...(children[relDir] || [])].sort(compareEntries);
    return entries.flatMap((entry) => {
      const isOpen = expanded.has(entry.relPath);
      const row = (
        <button
          key={entry.relPath}
          ref={(node) => {
            if (node) rowRefs.current.set(entry.relPath, node);
            else rowRefs.current.delete(entry.relPath);
          }}
          type="button"
          className={cn(
            'file-row',
            entry.relPath === activePath && 'active',
            entry.isSymlink && 'is-disabled',
          )}
          style={{ paddingLeft: 8 + depth * 12 }}
          title={entry.relPath}
          disabled={entry.isSymlink}
          onClick={() => (entry.isDir ? toggle(entry.relPath) : onOpen(entry.relPath))}
          onContextMenu={(event) => openRowMenu(event, entry)}
        >
          {entry.isDir ? (
            isOpen ? <ChevronRight size={12} className="file-caret open" /> : <ChevronRight size={12} className="file-caret" />
          ) : (
            <span className="file-caret-spacer" />
          )}
          {entry.isDir ? (
            isOpen ? <FolderOpen size={13} /> : <Folder size={13} />
          ) : (
            <File size={13} />
          )}
          <span className="file-name">{entry.name}</span>
        </button>
      );
      if (!entry.isDir || !isOpen) return [row];
      return [row, ...renderDir(entry.relPath, depth + 1)];
    });
  };

  return (
    <div className="file-tree-wrap">
      <div className="file-tree-toolbar">
        <button
          type="button"
          className="icon-btn"
          title="新建文件夹"
          onClick={() => void createFolder(createTargetDir())}
        >
          <FolderPlus size={13} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="新建文件"
          onClick={() => void createFile(createTargetDir())}
        >
          <FilePlus size={13} />
        </button>
        <button type="button" className="icon-btn" title="刷新" onClick={() => void reloadAll()}>
          <RefreshCw size={13} />
        </button>
        <button type="button" className="icon-btn" title="全部折叠" onClick={collapseAll}>
          <ChevronsDownUp size={13} />
        </button>
      </div>
      <div className="file-tree">
        {renderDir('', 0)}
        {menu ? <PopupMenu state={menu} onClose={() => setMenu(null)} /> : null}
      </div>
    </div>
  );
}

// 与项目里已有的 window.confirm 用法保持一致，避免再造一套输入弹窗。
// 返回完整相对路径（relDir/name），名字非法或取消时返回空串。
async function promptName(label: string, relDir: string, initial: string): Promise<string> {
  const raw = window.prompt(`${label}（${relDir || '项目根目录'}）`, initial);
  if (raw === null) return '';
  const name = raw.trim();
  if (!name) return '';
  if (name.includes('/') || name.includes('\\')) {
    window.alert('名字里不能包含斜杠');
    return '';
  }
  return relDir ? `${relDir}/${name}` : name;
}
