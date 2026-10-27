import { useCallback, useEffect, useState } from 'react';
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

export function FileTree({ group, activePath, onOpen, onError }: FileTreeProps) {
  const [children, setChildren] = useState<DirState>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));

  const loadDir = useCallback(
    async (relDir: string) => {
      try {
        const result = await window.api.files.list(group.path, relDir);
        setChildren((previous) => ({ ...previous, [relDir]: result.entries }));
      } catch (error) {
        onError(toErrorMessage(error));
      }
    },
    [group.path, onError],
  );

  useEffect(() => {
    setChildren({});
    setExpanded(new Set(['']));
    void loadDir('');
  }, [group.key, loadDir]);

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
    const entries = children[relDir] || [];
    return entries.flatMap((entry) => {
      const isOpen = expanded.has(entry.relPath);
      const row = (
        <button
          key={entry.relPath}
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
