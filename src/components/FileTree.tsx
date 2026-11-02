import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactElement, ReactNode } from 'react';
import {
  ChevronRight,
  ChevronsDownUp,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
} from 'lucide-react';
import { cn, toErrorMessage } from '../lib';
import { canPaste, pasteTargetDir } from '../fileClipboard';
import type { FileClip } from '../fileClipboard';
import type { FileEntry, Group, MenuEntry, MenuState } from '../types';
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
  clip: FileClip | null;
  onClipChange: (clip: FileClip | null) => void;
  onRequestDelete: (relPath: string) => void;
};

type DirState = Record<string, FileEntry[] | undefined>;

type PendingCreate = { kind: 'file' | 'directory'; relDir: string };

type PendingRename = { relPath: string; relDir: string; currentName: string };

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
  clip,
  onClipChange,
  onRequestDelete,
}: FileTreeProps) {
  const [children, setChildren] = useState<DirState>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [pendingRename, setPendingRename] = useState<PendingRename | null>(null);
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

  const createFile = useCallback((relDir: string) => {
    setPendingCreate({ kind: 'file', relDir });
  }, []);

  const createFolder = useCallback((relDir: string) => {
    setPendingCreate({ kind: 'directory', relDir });
  }, []);

  // 重命名也走输入弹窗：Electron 渲染进程不支持 window.prompt（实测会抛错）。
  // 用独立状态而不是复用 pendingCreate，因为两者语义与校验规则不同：
  // 重命名允许保持原名（此时直接关闭弹窗，不发请求）。
  const submitRename = useCallback(
    async (name: string) => {
      if (!pendingRename) return;
      const { relPath, relDir, currentName } = pendingRename;
      if (name === currentName) {
        setPendingRename(null);
        return;
      }
      const toRel = relDir ? `${relDir}/${name}` : name;
      await window.api.files.move(group.path, relPath, toRel);
      setPendingRename(null);
      await loadDir(relDir);
    },
    [group.path, loadDir, pendingRename],
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

  const pasteInto = useCallback(
    async (targetDir: string) => {
      const check = canPaste(clip, group.path);
      if (!clip || !check.ok) {
        onError(check.ok ? '剪贴板为空' : check.reason);
        return;
      }
      const toRel = pasteTargetDir(clip, targetDir);
      try {
        await window.api.files.move(group.path, clip.relPath, toRel);
        if (clip.kind === 'cut') onClipChange(null);
        await loadDir(targetDir);
        setExpanded((previous) => new Set(previous).add(targetDir));
        // 目录被移动后原目录的内容也失效了，整棵树重列一次最稳
        await reloadAll();
      } catch (error) {
        onError(toErrorMessage(error));
      }
    },
    [clip, group.path, loadDir, onClipChange, onError, reloadAll],
  );

  // 绝对路径要转成 Windows 分隔符，相对路径保持树里的 / 写法。
  // 仓库没有暴露 path.separator，用 group.path 自身判断分隔符最可靠。
  const copyPath = useCallback(
    async (relPath: string, relative: boolean) => {
      const sep = group.path.includes('\\') ? '\\' : '/';
      const absolute = `${group.path}${sep}${relPath.split('/').join(sep)}`;
      try {
        await window.api.clipboard.write(relative ? relPath : absolute);
        onError(`已复制${relative ? '相对' : ''}路径`);
      } catch (error) {
        onError(toErrorMessage(error));
      }
    },
    [group.path, onError],
  );

  const requestRename = useCallback((entry: FileEntry) => {
    setPendingRename({
      relPath: entry.relPath,
      relDir: ancestorsOf(entry.relPath).pop() || '',
      currentName: entry.name,
    });
  }, []);

  // 右键菜单按目标分两套：文件/文件夹一套，空白处一套。
  const openRowMenu = (event: React.MouseEvent, entry: FileEntry) => {
    event.preventDefault();
    event.stopPropagation();
    const dir = entry.isDir ? entry.relPath : ancestorsOf(entry.relPath).pop() || '';
    const paste = canPaste(clip, group.path);

    const items: MenuEntry[] = [
      {
        type: 'item',
        id: 'new-file',
        label: '新建文件',
        onSelect: () => createFile(dir),
      },
      {
        type: 'item',
        id: 'new-folder',
        label: '新建文件夹',
        onSelect: () => createFolder(dir),
      },
      { type: 'separator', id: 'sep-new' },
      {
        type: 'item',
        id: 'copy',
        label: '复制',
        onSelect: () =>
          onClipChange({ kind: 'copy', relPath: entry.relPath, projectPath: group.path }),
      },
      {
        type: 'item',
        id: 'cut',
        label: '剪切',
        onSelect: () =>
          onClipChange({ kind: 'cut', relPath: entry.relPath, projectPath: group.path }),
      },
      {
        type: 'item',
        id: 'paste',
        label: '粘贴',
        disabled: !paste.ok,
        onSelect: () => void pasteInto(dir),
      },
      { type: 'separator', id: 'sep-edit' },
      {
        type: 'item',
        id: 'rename',
        label: '重命名',
        onSelect: () => requestRename(entry),
      },
      {
        type: 'item',
        id: 'copy-path',
        label: '复制路径',
        onSelect: () => void copyPath(entry.relPath, false),
      },
      {
        type: 'item',
        id: 'copy-rel-path',
        label: '复制相对路径',
        onSelect: () => void copyPath(entry.relPath, true),
      },
      { type: 'separator', id: 'sep-danger' },
      {
        type: 'item',
        id: 'delete',
        label: '删除',
        onSelect: () => onRequestDelete(entry.relPath),
      },
    ];

    // 保留既有的「生成 xxx.min.js」
    if (!entry.isDir && canMinify(entry.relPath)) {
      const target = minifiedName(entry.relPath);
      const name = target.split('/').pop() || target;
      items.push({ type: 'separator', id: 'sep-minify' });
      items.push({
        type: 'item',
        id: 'file-minify',
        label: `生成 ${name}`,
        onSelect: () => onMinify(entry.relPath),
      });
    }

    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const openBlankMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const paste = canPaste(clip, group.path);
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { type: 'item', id: 'blank-new-file', label: '新建文件', onSelect: () => createFile('') },
        { type: 'item', id: 'blank-new-folder', label: '新建文件夹', onSelect: () => createFolder('') },
        {
          type: 'item',
          id: 'blank-paste',
          label: '粘贴',
          disabled: !paste.ok,
          onSelect: () => void pasteInto(''),
        },
        { type: 'separator', id: 'blank-sep' },
        { type: 'item', id: 'blank-refresh', label: '刷新', onSelect: () => void reloadAll() },
        { type: 'item', id: 'blank-collapse', label: '全部折叠', onSelect: collapseAll },
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
          onClick={() => createFolder(createTargetDir())}
        >
          <FolderPlus size={13} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="新建文件"
          aria-label="新建文件"
          onClick={() => createFile(createTargetDir())}
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
      <div className="file-tree" onContextMenu={openBlankMenu}>
        {renderDir('', 0)}
        {menu ? <PopupMenu state={menu} onClose={() => setMenu(null)} /> : null}
      </div>
      {pendingCreate ? (
        <NamePromptModal
          title={pendingCreate.kind === 'file' ? '新建文件' : '新建文件夹'}
          subtitle={`位置：${pendingCreate.relDir || '项目根目录'}`}
          icon={pendingCreate.kind === 'file' ? <FilePlus size={16} /> : <FolderPlus size={16} />}
          label={pendingCreate.kind === 'file' ? '文件名' : '文件夹名'}
          placeholder={pendingCreate.kind === 'file' ? '例如：index.ts' : '例如：components'}
          submitLabel="创建"
          busyLabel="创建中…"
          onClose={() => setPendingCreate(null)}
          onSubmit={submitCreate}
        />
      ) : null}
      {pendingRename ? (
        <NamePromptModal
          title="重命名"
          subtitle={`位置：${pendingRename.relDir || '项目根目录'}`}
          icon={<Pencil size={16} />}
          label="新名称"
          placeholder={pendingRename.currentName}
          initialValue={pendingRename.currentName}
          submitLabel="重命名"
          busyLabel="处理中…"
          onClose={() => setPendingRename(null)}
          onSubmit={submitRename}
        />
      ) : null}
    </div>
  );
}

// 新建 / 重命名共用的「输入名字」弹窗。Electron 渲染进程不支持 window.prompt，
// 统一走项目里的 Modal。两种用途各自持有状态，只共用这层输入与校验 UI。
type NamePromptModalProps = {
  title: string;
  subtitle: string;
  icon: ReactNode;
  label: string;
  placeholder: string;
  initialValue?: string;
  submitLabel: string;
  busyLabel: string;
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

function NamePromptModal({
  title,
  subtitle,
  icon,
  label,
  placeholder,
  initialValue = '',
  submitLabel,
  busyLabel,
  onClose,
  onSubmit,
}: NamePromptModalProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputId = useId();

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
      title={title}
      subtitle={subtitle}
      icon={icon}
      width={420}
      onClose={onClose}
      closeDisabled={busy}
    >
      <form className="modal-form" onSubmit={submit}>
        <div className="field">
          <label className="field-label" htmlFor={inputId}>
            {label}
          </label>
          <input
            id={inputId}
            className="text-input"
            value={value}
            data-autofocus
            spellCheck={false}
            placeholder={placeholder}
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
            {busy ? busyLabel : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
