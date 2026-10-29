import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { cn, toErrorMessage } from '../lib';
import { splitCommitPatch } from '../commitDiff';
import { parsePatch, type DiffLine } from '../diffParser';
import type { CommitRef, GitChange } from '../types';

export type DiffTarget =
  | { kind: 'change'; change: GitChange }
  | { kind: 'commit'; commit: CommitRef };

export type DiffPaneProps = {
  projectPath: string;
  wordWrap: boolean;
  target: DiffTarget;
  active: boolean;
  onClose: () => void;
  onOpenFile: (relPath: string) => void;
  onToast: (message: string, kind?: 'info' | 'success' | 'error') => void;
};

export function DiffPane({
  projectPath,
  wordWrap,
  target,
  active,
  onClose,
  onOpenFile,
  onToast,
}: DiffPaneProps) {
  const [patch, setPatch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedPath, setSelectedPath] = useState('');

  // target 对象每次渲染都是新的，依赖必须落在原始值上，否则会无限重取
  const commitHash = target.kind === 'commit' ? target.commit.hash : '';
  const changePath = target.kind === 'change' ? target.change.path : '';
  const changeStatus =
    target.kind === 'change'
      ? target.change.worktreeStatus ?? target.change.indexStatus ?? 'modified'
      : '';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSelectedPath('');
    const load = async () => {
      const result = commitHash
        ? await window.api.git.commitDiff(projectPath, commitHash)
        : await window.api.git.fileDiff(projectPath, changePath, changeStatus);
      return result.patch;
    };
    void load()
      .then((next) => {
        if (!cancelled) setPatch(next);
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
  }, [projectPath, commitHash, changePath, changeStatus, onToast]);

  const files = useMemo(
    () => (commitHash ? splitCommitPatch(patch) : []),
    [commitHash, patch],
  );
  const activeFile = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const parsed = parsePatch(commitHash ? activeFile?.patch || '' : patch);

  const title = commitHash
    ? `${target.kind === 'commit' ? target.commit.short : ''} · ${
        target.kind === 'commit' ? target.commit.subject : ''
      }`
    : target.kind === 'change' && target.change.origPath
      ? `${target.change.origPath} → ${target.change.path}`
      : changePath;

  const openPath = commitHash ? activeFile?.path || '' : changePath;
  const openDisabled = commitHash
    ? !activeFile || activeFile.status === 'deleted'
    : false;

  return (
    <section className={`terminal-pane diff-pane${active ? '' : ' is-hidden'}`}>
      <header className="pane-header">
        <span className="pane-path" title={title}>
          {title}
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
          <p className="diff-placeholder">没有可显示的差异</p>
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
