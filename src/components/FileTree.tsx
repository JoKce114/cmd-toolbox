import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ChevronRight, File, Folder, FolderOpen } from 'lucide-react';
import { cn, toErrorMessage } from '../lib';
import type { FileEntry, Group } from '../types';

type FileTreeProps = {
  group: Group;
  activePath: string;
  onOpen: (relPath: string) => void;
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

export function FileTree({ group, activePath, onOpen, onError }: FileTreeProps) {
  const [children, setChildren] = useState<DirState>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
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

  return <div className="file-tree">{renderDir('', 0)}</div>;
}
