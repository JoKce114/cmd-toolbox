import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  ArrowUp,
  Check,
  FileDiff,
  GitBranch,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
} from 'lucide-react';
import { cn } from '../lib';
import type { GitChange, GitChangeStatus, GitStatus } from '../types';
import { BranchMenu } from './BranchMenu';
import { NewBranchModal } from './NewBranchModal';

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
  onStage: (paths: string[]) => Promise<boolean>;
  onUnstage: (paths: string[]) => Promise<boolean>;
  onDiscard: (payload: { tracked: string[]; untracked: string[] }) => Promise<boolean>;
  onStageAll: () => Promise<boolean>;
  onDiscardAll: () => Promise<boolean>;
  branches: string[];
  currentBranch: string;
  branchBusy: boolean;
  onCheckout: (branch: string) => void;
  onCreateBranch: (name: string, startPoint: string) => void;
  onMerge: (branch: string) => void;
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
  onStage,
  onUnstage,
  onDiscard,
  onStageAll,
  onDiscardAll,
  branches,
  currentBranch,
  branchBusy,
  onCheckout,
  onCreateBranch,
  onMerge,
}: GitPanelProps) {
  const [message, setMessage] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [committedMessage, setCommittedMessage] = useState('');
  const [initBusy, setInitBusy] = useState(false);
  const [busyPaths, setBusyPaths] = useState<Set<string>>(new Set());
  const [groupBusy, setGroupBusy] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<
    | { kind: 'single'; change: GitChange }
    | { kind: 'all' }
    | null
  >(null);

  const runPathAction = async (key: string, action: () => Promise<boolean>) => {
    setBusyPaths((previous) => new Set(previous).add(key));
    try {
      await action();
    } finally {
      setBusyPaths((previous) => {
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
    }
  };

  const runGroupAction = async (action: () => Promise<boolean>) => {
    setGroupBusy(true);
    try {
      await action();
    } finally {
      setGroupBusy(false);
    }
  };

  const busy = phase === 'committing' || phase === 'pushing';
  const messageFilled = message.trim().length > 0;
  const canCommit =
    phase === 'idle' && messageFilled && Boolean(status?.ok && status.stagedCount > 0);

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

  const stagedChanges = status.changes.filter((c) => c.indexStatus !== null);
  const unstagedChanges = status.changes.filter((c) => c.worktreeStatus !== null);

  const renderRow = (change: GitChange, staged: boolean) => {
    const display = staged ? change.indexStatus : change.worktreeStatus;
    const badge = display ?? 'modified';
    const busy = busyPaths.has(change.path);

    return (
      <li key={`${staged ? 's' : 'w'}:${change.path}`} className="git-change-item">
        <button
          type="button"
          className="git-change-row"
          title={change.origPath ? `${change.origPath} → ${change.path}` : change.path}
          onClick={() =>
            change.worktreeStatus === 'deleted' ? onOpenDiff(change) : onOpenInEditor(change)
          }
        >
          <span className={cn('git-change-badge', `is-${badge}`)}>{STATUS_LABEL[badge]}</span>
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

        {staged ? (
          <button
            type="button"
            className="git-row-action"
            title="取消暂存"
            disabled={busy}
            onClick={() => void runPathAction(change.path, () => onUnstage([change.path]))}
          >
            <Undo2 size={13} />
          </button>
        ) : (
          <>
            <button
              type="button"
              className="git-row-action"
              title="放弃修改"
              disabled={busy}
              onClick={() => setConfirmDiscard({ kind: 'single', change })}
            >
              <Trash2 size={13} />
            </button>
            <button
              type="button"
              className="git-row-action"
              title="暂存"
              disabled={busy}
              onClick={() => void runPathAction(change.path, () => onStage([change.path]))}
            >
              <Plus size={13} />
            </button>
          </>
        )}
      </li>
    );
  };

  const discardMessage =
    confirmDiscard?.kind === 'all'
      ? `放弃全部 ${unstagedChanges.length} 项修改？其中未跟踪文件将被删除。此操作无法撤销。`
      : confirmDiscard
        ? confirmDiscard.change.worktreeStatus === 'untracked'
          ? `删除未跟踪文件「${confirmDiscard.change.path}」？此操作无法撤销。`
          : `放弃对「${confirmDiscard.change.path}」的修改？此操作无法撤销。`
        : '';

  return (
    <section className="git-panel">
      {header}
      <div className="git-branch-bar">
        <button
          type="button"
          className="git-branch-button"
          title="切换或新建分支"
          onClick={() => setBranchMenuOpen((open) => !open)}
        >
          <GitBranch size={12} />
          <span className="git-branch-name">{status.branch || '未知分支'}</span>
          {status.ahead > 0 ? <span className="git-ahead">↑{status.ahead}</span> : null}
          {status.behind > 0 ? <span className="git-behind">↓{status.behind}</span> : null}
        </button>

        {branchMenuOpen ? (
          <BranchMenu
            branches={branches}
            current={currentBranch || status.branch}
            busy={branchBusy}
            onSelect={onCheckout}
            onMerge={onMerge}
            onCreate={() => setNewBranchOpen(true)}
            onClose={() => setBranchMenuOpen(false)}
          />
        ) : null}
      </div>

      {newBranchOpen ? (
        <NewBranchModal
          branches={branches}
          current={currentBranch || status.branch}
          busy={branchBusy}
          onClose={() => setNewBranchOpen(false)}
          onConfirm={(name, startPoint) => {
            setNewBranchOpen(false);
            onCreateBranch(name, startPoint);
          }}
        />
      ) : null}

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

      {stagedChanges.length > 0 ? (
        <div className="git-group">
          <div className="git-group-head">
            <span className="git-group-title">已暂存</span>
            <span className="git-group-count">{stagedChanges.length}</span>
            <button
              type="button"
              className="git-group-action"
              title="全部取消暂存"
              disabled={groupBusy}
              onClick={() =>
                void runGroupAction(() => onUnstage(stagedChanges.map((c) => c.path)))
              }
            >
              <Undo2 size={13} />
            </button>
          </div>
          <ul className="git-change-list">
            {stagedChanges.map((change) => renderRow(change, true))}
          </ul>
        </div>
      ) : null}

      {unstagedChanges.length > 0 ? (
        <div className="git-group">
          <div className="git-group-head">
            <span className="git-group-title">更改</span>
            <span className="git-group-count">{unstagedChanges.length}</span>
            <button
              type="button"
              className="git-group-action"
              title="全部放弃"
              disabled={groupBusy}
              onClick={() => setConfirmDiscard({ kind: 'all' })}
            >
              <Trash2 size={13} />
            </button>
            <button
              type="button"
              className="git-group-action"
              title="全部暂存"
              disabled={groupBusy}
              onClick={() => void runGroupAction(() => onStageAll())}
            >
              <Plus size={13} />
            </button>
          </div>
          <ul className="git-change-list">
            {unstagedChanges.map((change) => renderRow(change, false))}
          </ul>
        </div>
      ) : null}

      {confirmDiscard ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card editor-confirm">
            <p className="confirm-message">{discardMessage}</p>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirmDiscard(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const target = confirmDiscard;
                  setConfirmDiscard(null);
                  if (target.kind === 'all') void runGroupAction(() => onDiscardAll());
                  else {
                    const change = target.change;
                    const tracked = change.worktreeStatus === 'untracked' ? [] : [change.path];
                    const untracked = change.worktreeStatus === 'untracked' ? [change.path] : [];
                    void runPathAction(change.path, () => onDiscard({ tracked, untracked }));
                  }
                }}
              >
                确定放弃
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
