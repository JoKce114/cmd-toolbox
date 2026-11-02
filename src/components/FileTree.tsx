import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
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
import { Modal } from './Modal';
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

type PendingCreate = { kind: 'file' | 'directory'; relDir: string };

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
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingRevealRef = useRef('');
  const reloadingRef = useRef(false);

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

  // 刷新：先清掉符号索引（外部改动后立即重扫），再重新列所有已展开的目录。
  // 不清空 children，避免整树闪白；并发限制在 4 个；重复点击直接忽略。
  const reloadAll = useCallback(async () => {
    if (reloadingRef.current) return;
    reloadingRef.current = true;
    try {
      try {
        await window.api.symbols.invalidate(group.path);
      } catch {
        // 索引清理失败不影响刷新：过期索引在下次查询时也会自动重建。
      }
      const dirs = Array.from(expanded);
      let next = 0;
      const worker = async () => {
        while (next < dirs.length) {
          const dir = dirs[next];
          next += 1;
          await loadDir(dir);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(4, dirs.length) }, () => worker()),
      );
    } finally {
      reloadingRef.current = false;
    }
  }, [expanded, group.path, loadDir]);

  const collapseAll = useCallback(() => {
    setExpanded(new Set(['']));
  }, []);

  // 新建按钮的落点：activePath 是当前打开的文件，新建条目与它同级；
  // 没有打开文件时落在项目根目录。
  const createTargetDir = useCallback(() => {
    if (!activePath) return '';
    return ancestorsOf(activePath).pop() || '';
  }, [activePath]);

  // 弹窗提交成功后才真正落盘：新建条目与当前打开的文件同级，
  // 没有打开文件时落在项目根目录。
  const submitCreate = useCallback(
    async (name: string) => {
      if (!pendingCreate) return;
      const { kind, relDir } = pendingCreate;
      const relPath = relDir ? `${relDir}/${name}` : name;
      if (kind === 'file') {
        await window.api.files.createFile(group.path, relPath, '');
      } else {
        await window.api.files.createDir(group.path, relPath);
      }
      await loadDir(relDir);
      setExpanded((previous) => new Set(previous).add(relDir));
      setPendingCreate(null);
      if (kind === 'file') onOpen(relPath);
    },
    [group.path, loadDir, onOpen, pendingCreate],
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
          aria-label="新建文件夹"
          onClick={() => setPendingCreate({ kind: 'directory', relDir: createTargetDir() })}
        >
          <FolderPlus size={13} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="新建文件"
          aria-label="新建文件"
          onClick={() => setPendingCreate({ kind: 'file', relDir: createTargetDir() })}
        >
          <FilePlus size={13} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="刷新"
          aria-label="刷新"
          onClick={() => void reloadAll()}
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="全部折叠"
          aria-label="全部折叠"
          onClick={collapseAll}
        >
          <ChevronsDownUp size={13} />
        </button>
      </div>
      <div className="file-tree">
        {renderDir('', 0)}
        {menu ? <PopupMenu state={menu} onClose={() => setMenu(null)} /> : null}
      </div>
      {pendingCreate ? (
        <CreateEntryModal
          kind={pendingCreate.kind}
          relDir={pendingCreate.relDir}
          onClose={() => setPendingCreate(null)}
          onSubmit={submitCreate}
        />
      ) : null}
    </div>
  );
}

// 新建文件 / 文件夹的输入弹窗。Electron 渲染进程不支持 window.prompt，
// 统一走项目里的 Modal。
type CreateEntryModalProps = {
  kind: 'file' | 'directory';
  relDir: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
};

function validateName(raw: string): string {
  const name = raw.trim();
  if (!name) return '名字不能为空';
  if (name === '.' || name === '..') return '名字不能是 . 或 ..';
  if (/[\\/]/.test(name)) return '名字里不能包含 / 或 \\';
  if (/[<>:"|?*]/.test(name)) return '名字不能包含 < > : " | ? * 这些字符';
  return '';
}

function CreateEntryModal({ kind, relDir, onClose, onSubmit }: CreateEntryModalProps) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isFile = kind === 'file';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const message = validateName(value);
    if (message) {
      setError(message);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit(value.trim());
    } catch (submitError) {
      setError(toErrorMessage(submitError));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isFile ? '新建文件' : '新建文件夹'}
      subtitle={`位置：${relDir || '项目根目录'}`}
      icon={isFile ? <FilePlus size={16} /> : <FolderPlus size={16} />}
      width={420}
      onClose={onClose}
      closeDisabled={busy}
    >
      <form className="modal-form" onSubmit={submit}>
        <div className="field">
          <label className="field-label" htmlFor="file-tree-new-name">
            {isFile ? '文件名' : '文件夹名'}
          </label>
          <input
            id="file-tree-new-name"
            className="text-input"
            value={value}
            data-autofocus
            spellCheck={false}
            placeholder={isFile ? '例如：index.ts' : '例如：components'}
            onChange={(event) => {
              setValue(event.target.value);
              setError('');
            }}
          />
          <div className="field-hint">
            {'不能包含 / \\ < > : " | ? *，也不能是 . 或 ..'}
          </div>
        </div>
        {error ? (
          <div className="field-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
