import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { cn, toErrorMessage } from '../lib';
import { parsePatch, type DiffLine } from '../diffParser';
import type { GitChange } from '../types';

export type DiffPaneProps = {
  projectPath: string;
  change: GitChange;
  active: boolean;
  onClose: () => void;
  onOpenFile: (relPath: string) => void;
  onToast: (message: string, kind?: 'info' | 'success' | 'error') => void;
};

export function DiffPane({
  projectPath,
  change,
  active,
  onClose,
  onOpenFile,
  onToast,
}: DiffPaneProps) {
  const [patch, setPatch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.api.git
      .fileDiff(projectPath, change.path, change.worktreeStatus ?? change.indexStatus ?? 'modified')
      .then((result) => {
        if (!cancelled) setPatch(result.patch);
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
  }, [projectPath, change.path, change.worktreeStatus, change.indexStatus, onToast]);

  const parsed = parsePatch(patch);

  return (
    <section className={`terminal-pane diff-pane${active ? '' : ' is-hidden'}`}>
      <header className="pane-header">
        <span className="pane-path" title={change.origPath ? `${change.origPath} → ${change.path}` : change.path}>
          {change.origPath ? `${change.origPath} → ${change.path}` : change.path}
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
          onClick={() => onOpenFile(change.path)}
        >
          打开文件
        </button>
        <button type="button" className="icon-btn" title="关闭" onClick={onClose}>
          <X size={14} />
        </button>
      </header>

      <div className="diff-body">
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
