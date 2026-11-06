import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cn, toErrorMessage } from '../lib';
import { splitCommitPatch } from '../commitDiff';
import { parsePatch, type DiffLine } from '../diffParser';
import type { CommitRef, GitChange } from '../types';

export type DiffTarget =
  | { kind: 'change'; change: GitChange }
  | { kind: 'commit'; commit: CommitRef }
  // 两段文本直接算好的 patch，不读磁盘也不读 git
  | { kind: 'text'; title: string; patch: string };

export type DiffPaneProps = {
  projectPath: string;
  wordWrap: boolean;
  target: DiffTarget;
  active: boolean;
  onClose: () => void;
  onOpenFile: (relPath: string) => void;
  onToast: (message: string, kind?: 'info' | 'success' | 'error') => void;
  // 用户第一次在这个页签里按下鼠标或滚动时回调一次；上层据此不再复用它
  onInteract?: () => void;
  // 外部改动磁盘后递增（编辑器保存、暂存/放弃/提交），用来重新读取最新差异
  refreshToken?: number;
};

export function DiffPane({
  projectPath,
  wordWrap,
  target,
  active,
  onClose,
  onOpenFile,
  onToast,
  onInteract,
  refreshToken = 0,
}: DiffPaneProps) {
  const [patch, setPatch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedPath, setSelectedPath] = useState('');
  // 页签切回来、窗口重新获得焦点时磁盘可能已经被改过，各补一次重新读取
  const [reloadTick, setReloadTick] = useState(0);

  // 只上报第一次交互：页签被复用时不重建组件，标记随之保留
  const interactedRef = useRef(false);
  const markInteracted = () => {
    if (interactedRef.current) return;
    interactedRef.current = true;
    onInteract?.();
  };

  // target 对象每次渲染都是新的，依赖必须落在原始值上，否则会无限重取
  const isText = target.kind === 'text';
  const textPatch = target.kind === 'text' ? target.patch : '';
  const commitHash = target.kind === 'commit' ? target.commit.hash : '';
  const changePath = target.kind === 'change' ? target.change.path : '';
  const changeStatus =
    target.kind === 'change'
      ? target.change.worktreeStatus ?? target.change.indexStatus ?? 'modified'
      : '';

  // 同一个页签会被复用成别的文件，加载状态要按「当前看的到底是哪份 diff」判断
  const targetKey = `${commitHash}|${changePath}`;
  const loadedKeyRef = useRef('');

  // 隐藏页签不重建组件，只有 active 翻转时才知道「用户又回来看了」
  const wasActiveRef = useRef(active);
  useEffect(() => {
    if (active && !wasActiveRef.current) setReloadTick((tick) => tick + 1);
    wasActiveRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const handleFocus = () => setReloadTick((tick) => tick + 1);
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [active]);

  useEffect(() => {
    setSelectedPath('');
    // text 变体的 patch 是上层算好的，直接渲染，不发起任何 IPC
    if (isText) {
      setLoading(false);
      setPatch(textPatch);
      return;
    }
    let cancelled = false;
    // 目标文件没变时静默刷新，别让每次切回页签都闪一下「正在读取差异…」
    setLoading(loadedKeyRef.current !== targetKey);
    const load = async () => {
      const result = commitHash
        ? await window.api.git.commitDiff(projectPath, commitHash)
        : await window.api.git.fileDiff(projectPath, changePath, changeStatus);
      return result.patch;
    };
    void load()
      .then((next) => {
        if (cancelled) return;
        loadedKeyRef.current = targetKey;
        setPatch(next);
      })
      .catch((error) => {
        if (!cancelled) onToast(toErrorMessage(error), 'error');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    isText,
    textPatch,
    projectPath,
    commitHash,
    changePath,
    changeStatus,
    targetKey,
    refreshToken,
    reloadTick,
    onToast,
  ]);

  const files = useMemo(
    () => (commitHash ? splitCommitPatch(patch) : []),
    [commitHash, patch],
  );
  const activeFile = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const parsed = parsePatch(commitHash ? activeFile?.patch || '' : patch);

  let title = changePath;
  if (target.kind === 'text') {
    title = target.title;
  } else if (target.kind === 'commit') {
    title = `${target.commit.short} · ${target.commit.subject}`;
  } else if (target.change.origPath) {
    title = `${target.change.origPath} → ${target.change.path}`;
  }

  const openPath = commitHash ? activeFile?.path || '' : changePath;
  // text 变体对应两段内存文本，没有可单独打开的磁盘文件
  const openDisabled =
    target.kind === 'text'
      ? true
      : target.kind === 'commit'
        ? !activeFile || activeFile.status === 'deleted'
        : false;

  return (
    <section
      className={`terminal-pane diff-pane${active ? '' : ' is-hidden'}`}
      onPointerDown={markInteracted}
      onWheel={markInteracted}
    >
      <header className="pane-header">
        <span className="pane-path" title={title}>
          <span>{title}</span>
        </span>
        {!parsed.isEmpty ? (
          <span className="diff-stats">
            <span className="diff-added">+{parsed.added}</span>
            <span className="diff-removed">−{parsed.removed}</span>
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn-secondary btn-sm diff-open-file"
          title="打开文件编辑"
          disabled={openDisabled}
          onClick={() => {
            if (openPath) onOpenFile(openPath);
          }}
        >
          打开文件
        </button>
        <button type="button" className="icon-btn" title="关闭" onClick={onClose}>
          <X size={14} />
        </button>
      </header>

      {commitHash ? (
        <div className="diff-file-bar">
          <span className="diff-file-label">文件 {files.length}</span>
          <select
            className="diff-file-select"
            value={activeFile?.path || ''}
            onChange={(event) => setSelectedPath(event.target.value)}
          >
            {files.map((file) => (
              <option key={file.path} value={file.path}>
                {file.status === 'renamed' && file.origPath
                  ? `${file.origPath} → ${file.path}`
                  : file.path}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className={`diff-body${wordWrap ? ' is-wrapped' : ''}`}>
        {loading ? (
          <p className="diff-placeholder">正在读取差异…</p>
        ) : parsed.isEmpty ? (
          <p className="diff-placeholder">{isText ? '两处内容一致' : '没有可显示的差异'}</p>
        ) : (
          parsed.hunks.map((hunk, hunkIndex) => (
            <div className="diff-hunk" key={`${hunk.header}:${hunkIndex}`}>
              <div className="diff-hunk-header">{hunk.header}</div>
              {hunk.lines.map((line, lineIndex) => (
                <DiffRow key={lineIndex} line={line} />
              ))}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  if (line.kind === 'header') return null;
  return (
    <div className={cn('diff-row', `is-${line.kind}`)}>
      <span className="diff-gutter">{line.oldLine ?? ''}</span>
      <span className="diff-gutter">{line.newLine ?? ''}</span>
      <span className="diff-sign">
        {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
      </span>
      <span className="diff-text">{line.text || ' '}</span>
    </div>
  );
}
