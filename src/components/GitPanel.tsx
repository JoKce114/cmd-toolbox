import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  ArrowDownToLine,
  ArrowUp,
  Check,
  FileCode,
  GitBranch,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
} from 'lucide-react';
import { cn } from '../lib';
import type { GitChange, GitChangeStatus, GitStatus } from '../types';
import { BranchMenu } from './BranchMenu';
import { ConfirmDialog } from './ConfirmDialog';
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
  onPull: () => void;
  pullBusy: boolean;
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
  commits: Array<{ hash: string; short: string; author: string; when: string; subject: string }>;
};

export function GitPanel({
  status,
  refreshing,
  onRefresh,
  onCommit,
  onPush,
  onPull,
  pullBusy,
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
  commits,
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

  const changes = status?.ok ? status.changes : [];
  // 冲突项没有可用的暂存/取消暂存语义，只能到终端解决
  const stagedChanges = changes.filter(
    (change) => change.indexStatus !== null && change.indexStatus !== 'conflicted',
  );
  const unstagedChanges = changes.filter((change) => change.worktreeStatus !== null);
  const hasConflicts = changes.some(
    (change) => change.indexStatus === 'conflicted' || change.worktreeStatus === 'conflicted',
  );
  const canCommit = phase === 'idle' && messageFilled && stagedChanges.length > 0;

  const pathsFor = (change: GitChange) =>
    change.origPath ? [change.origPath, change.path] : [change.path];

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

  const renderRow = (change: GitChange, staged: boolean) => {
    const display = staged ? change.indexStatus : change.worktreeStatus;
    const badge = display ?? 'modified';
    const busy = busyPaths.has(change.path) || groupBusy;
    const conflicted =
      change.indexStatus === 'conflicted' || change.worktreeStatus === 'conflicted';

    return (
      <li key={`${staged ? 's' : 'w'}:${change.path}`} className="git-change-item">
        <button
          type="button"
          className="git-change-row"
          title={change.origPath ? `${change.origPath} → ${change.path}` : change.path}
          onClick={() => onOpenDiff(change)}
        >
          <span className={cn('git-change-badge', `is-${badge}`)}>{STATUS_LABEL[badge]}</span>
          <span className="git-change-path">
            {change.origPath ? `${change.origPath} → ${change.path}` : change.path}
          </span>
        </button>

        <button
          type="button"
          className="git-row-action"
          title="打开文件编辑"
          onClick={() => onOpenInEditor(change)}
        >
          <FileCode size={13} />
        </button>

        {conflicted ? (
          <span className="git-conflict-hint" title="冲突需要先在终端解决">
            需在终端解决
          </span>
        ) : staged ? (
          <button
            type="button"
            className="git-row-action"
            title="取消暂存"
            disabled={busy}
            onClick={() => void runPathAction(change.path, () => onUnstage(pathsFor(change)))}
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
              onClick={() => void runPathAction(change.path, () => onStage(pathsFor(change)))}
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

        {status.behind > 0 ? (
          <button
            type="button"
            className="git-pull-button"
            title={`线上有 ${status.behind} 个新提交，点击拉取`}
            disabled={pullBusy}
            onClick={onPull}
          >
            <ArrowDownToLine size={12} className={pullBusy ? 'is-spinning' : undefined} />
            <span>{pullBusy ? '拉取中…' : '拉取'}</span>
          </button>
        ) : null}

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
                void runGroupAction(() => onUnstage(stagedChanges.flatMap((c) => pathsFor(c))))
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
              title={hasConflicts ? '请先在终端解决冲突' : '全部放弃'}
              disabled={groupBusy || hasConflicts}
              onClick={() => setConfirmDiscard({ kind: 'all' })}
            >
              <Trash2 size={13} />
            </button>
            <button
              type="button"
              className="git-group-action"
              title={hasConflicts ? '请先在终端解决冲突' : '全部暂存'}
              disabled={groupBusy || hasConflicts}
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
        <ConfirmDialog
          title="放弃修改"
          message={discardMessage}
          confirmLabel="确定放弃"
          onClose={() => setConfirmDiscard(null)}
          onConfirm={async () => {
            const target = confirmDiscard;
            if (!target) return;
            if (target.kind === 'all') {
              await runGroupAction(() => onDiscardAll());
            } else {
              const change = target.change;
              const targetPaths = pathsFor(change);
              const tracked = change.worktreeStatus === 'untracked' ? [] : targetPaths;
              const untracked = change.worktreeStatus === 'untracked' ? targetPaths : [];
              await runPathAction(change.path, () => onDiscard({ tracked, untracked }));
            }
            setConfirmDiscard(null);
          }}
        />
      ) : null}

      <div className="git-history">
        <div className="git-group-head">
          <span className="git-history-title">最近提交</span>
          <span className="git-group-count">{commits.length}</span>
        </div>
        {commits.length === 0 ? (
          <p className="git-panel-hint">还没有提交记录</p>
        ) : (
          <ul className="git-history-list">
            {commits.map((commit) => (
              <li key={commit.hash} className="git-history-item">
                <span className="git-history-subject" title={commit.subject}>
                  {commit.subject}
                </span>
                <span className="git-history-meta">
                  {commit.short} · {commit.author} · {commit.when}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
