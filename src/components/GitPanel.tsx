import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowUp, Check, FileDiff, RefreshCw } from 'lucide-react';
import { cn } from '../lib';
import type { GitChange, GitChangeStatus, GitStatus } from '../types';

type Phase = 'idle' | 'committing' | 'committed' | 'pushing';

const STATUS_LABEL: Record<GitChangeStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
  conflicted: '!',
};

export type GitPanelProps = {
  status: GitStatus | null;
  refreshing: boolean;
  onRefresh: () => void;
  onCommit: (message: string) => Promise<boolean>;
  onPush: () => Promise<boolean>;
  onInit: () => Promise<boolean>;
  onOpenDiff: (change: GitChange) => void;
  onOpenInEditor: (change: GitChange) => void;
};

export function GitPanel({
  status,
  refreshing,
  onRefresh,
  onCommit,
  onPush,
  onInit,
  onOpenDiff,
  onOpenInEditor,
}: GitPanelProps) {
  const [message, setMessage] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [committedMessage, setCommittedMessage] = useState('');
  const [initBusy, setInitBusy] = useState(false);

  const busy = phase === 'committing' || phase === 'pushing';
  const messageFilled = message.trim().length > 0;
  const canCommit =
    phase === 'idle' && messageFilled && Boolean(status?.ok && status.hasChanges);

  const resetToIdle = () => {
    setPhase('idle');
    setMessage('');
    setCommittedMessage('');
  };

  const runCommit = async () => {
    if (!canCommit) return;
    setPhase('committing');
    const ok = await onCommit(message.trim());
    if (!ok) {
      setPhase('idle');
      return;
    }
    setCommittedMessage(message.trim());
    setMessage('');
    setPhase('committed');
  };

  const runPush = async () => {
    setPhase('pushing');
    const ok = await onPush();
    if (!ok) {
      setPhase('committed');
      return;
    }
    resetToIdle();
  };

  const submit = () => {
    if (phase === 'committed') void runPush();
    else void runCommit();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && event.ctrlKey) {
      event.preventDefault();
      if (phase === 'committed') void runPush();
      else void runCommit();
    }
  };

  const header = (
    <header className="git-panel-head">
      <span className="git-panel-title">源代码管理</span>
      <button
        type="button"
        className="git-icon-btn"
        title="刷新"
        aria-label="刷新 Git 状态"
        disabled={refreshing}
        onClick={onRefresh}
      >
        <RefreshCw size={13} className={refreshing ? 'is-spinning' : undefined} />
      </button>
    </header>
  );

  if (!status) {
    return (
      <section className="git-panel">
        {header}
        <p className="git-panel-hint">正在读取 Git 状态…</p>
      </section>
    );
  }

  if (!status.ok) {
    return (
      <section className="git-panel">
        {header}
        <p className="git-panel-hint">{status.message}</p>
        {status.reason === 'not-repo' ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm git-init-btn"
            disabled={initBusy}
            onClick={async () => {
              setInitBusy(true);
              await onInit();
              setInitBusy(false);
            }}
          >
            {initBusy ? '初始化中…' : '初始化仓库'}
          </button>
        ) : null}
      </section>
    );
  }

  return (
    <section className="git-panel">
      {header}
      <div className="git-branch-bar">
        <span className="git-branch-name" title={status.branch}>
          {status.branch || '未知分支'}
        </span>
        {status.ahead > 0 ? <span className="git-ahead">↑{status.ahead}</span> : null}
        {status.behind > 0 ? <span className="git-behind">↓{status.behind}</span> : null}
      </div>

      {status.hasChanges || phase === 'committed' ? (
        <>
          <textarea
            className="git-message"
            value={phase === 'committed' ? `已提交：${committedMessage}` : message}
            readOnly={phase === 'committed'}
            rows={3}
            placeholder="提交信息（Ctrl+Enter 提交）"
            spellCheck={false}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="git-actions">
            <button
              type="button"
              className={cn(
                'btn',
                'git-submit',
                phase === 'committed' ? 'btn-primary' : 'btn-secondary',
              )}
              disabled={busy || (phase === 'idle' && !canCommit)}
              onClick={submit}
            >
              {phase === 'committed' || phase === 'pushing' ? (
                <>
                  <ArrowUp size={13} />
                  {phase === 'pushing' ? '推送中…' : '推送'}
                </>
              ) : (
                <>
                  <Check size={13} />
                  {phase === 'committing' ? '提交中…' : '提交'}
                </>
              )}
            </button>
            {phase === 'committed' ? (
              <button type="button" className="git-continue" onClick={resetToIdle}>
                继续编辑
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="git-panel-hint">没有变更</p>
      )}

      {status.changes.length > 0 ? (
        <ul className="git-change-list">
          {status.changes.map((change) => {
            const displayStatus = change.indexStatus ?? change.worktreeStatus ?? 'modified';
            return (
              <li key={`${displayStatus}:${change.path}`} className="git-change-item">
                <button
                  type="button"
                  className="git-change-row"
                  title={change.origPath ? `${change.origPath} → ${change.path}` : change.path}
                  onClick={() =>
                    change.worktreeStatus === 'deleted' ? onOpenDiff(change) : onOpenInEditor(change)
                  }
                >
                  <span className={cn('git-change-badge', `is-${displayStatus}`)}>
                    {STATUS_LABEL[displayStatus]}
                  </span>
                  <span className="git-change-path">
                    {change.origPath ? `${change.origPath} → ${change.path}` : change.path}
                  </span>
                </button>
                <button
                  type="button"
                  className="git-row-action"
                  title="在终端查看差异"
                  onClick={() => onOpenDiff(change)}
                >
                  <FileDiff size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
