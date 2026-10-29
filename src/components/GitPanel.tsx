import {
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  Archive,
  ArrowDownToLine,
  ArrowUp,
  Check,
  ChevronRight,
  FileCode,
  GitBranch,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Undo2,
} from 'lucide-react';
import { cn } from '../lib';
import { useCollapsedSection } from '../useCollapsedSection';
import type {
  GitChange,
  GitChangeStatus,
  GitStatus,
  HeadCommit,
  MenuEntry,
  StashEntry,
  SyncPrompt,
} from '../types';
import { PopupMenu } from './PopupMenu';
import { AmendModal } from './AmendModal';
import { BranchPickerModal } from './BranchPickerModal';
import { MergeModal } from './MergeModal';
import { ConfirmDialog } from './ConfirmDialog';
import { NewBranchModal } from './NewBranchModal';
import { SyncDialog } from './SyncDialog';
import type { SyncChoice } from './SyncDialog';

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
  onMergeInto: (source: string, target: string) => void;
  syncPrompt: SyncPrompt | null;
  syncBusy: boolean;
  onSyncChoice: (choice: SyncChoice) => void;
  onSyncClose: () => void;
  commits: Array<{ hash: string; short: string; author: string; when: string; subject: string }>;
  onOpenCommit: (commit: {
    hash: string;
    short: string;
    author: string;
    when: string;
    subject: string;
  }) => void;
  head: HeadCommit | null;
  onRefreshHead: () => Promise<HeadCommit | null>;
  onUndoCommit: () => Promise<string | null>;
  onAmend: (message: string) => Promise<boolean>;
  onStashSave: () => Promise<boolean>;
  stashes: StashEntry[];
  stashBusy: string | null;
  onStashPop: (ref: string) => Promise<boolean>;
  onStashDrop: (ref: string) => Promise<boolean>;
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
  onMergeInto,
  syncPrompt,
  syncBusy,
  onSyncChoice,
  onSyncClose,
  commits,
  onOpenCommit,
  head,
  onRefreshHead,
  onUndoCommit,
  onAmend,
  onStashSave,
  stashes,
  stashBusy,
  onStashPop,
  onStashDrop,
}: GitPanelProps) {
  const [message, setMessage] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [pushBusy, setPushBusy] = useState(false);
  const [committedMessage, setCommittedMessage] = useState('');
  const [initBusy, setInitBusy] = useState(false);
  const [busyPaths, setBusyPaths] = useState<Set<string>>(new Set());
  const [groupBusy, setGroupBusy] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<
    | { kind: 'single'; change: GitChange }
    | { kind: 'all' }
    | null
  >(null);
  const [panelCollapsed, togglePanel] = useCollapsedSection('git');
  const [historyCollapsed, toggleHistory] = useCollapsedSection('git-history', true);
  const [stashCollapsed, toggleStash, setStashCollapsed] = useCollapsedSection(
    'git-stash',
    true,
  );
  const [confirmDropStash, setConfirmDropStash] = useState<string | null>(null);
  const [confirmUndo, setConfirmUndo] = useState<HeadCommit | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const [amendHead, setAmendHead] = useState<HeadCommit | null>(null);
  const [amendBusy, setAmendBusy] = useState(false);
  const [headBusy, setHeadBusy] = useState(false);
  const [stashSaving, setStashSaving] = useState(false);
  const [opsMenu, setOpsMenu] = useState<{ x: number; y: number } | null>(null);

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
  // 冲突项没有可用的暂存/取消暂存语义，只能点「解决冲突」进编辑器处理
  const stagedChanges = changes.filter(
    (change) => change.indexStatus !== null && change.indexStatus !== 'conflicted',
  );
  const unstagedChanges = changes.filter((change) => change.worktreeStatus !== null);
  const hasConflicts = changes.some(
    (change) => change.indexStatus === 'conflicted' || change.worktreeStatus === 'conflicted',
  );
  const canCommit = phase === 'idle' && messageFilled && stagedChanges.length > 0;
  const aheadCount = status && status.ok ? status.ahead : 0;
  // 提交块里已经有「推送」时不再重复显示分支栏按钮
  const showBarPush = aheadCount > 0 && phase !== 'committed' && phase !== 'pushing';

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

  // 分支栏的推送入口不依赖一次性的提交阶段：切换项目重挂载后仍按 ahead 显示
  const runBarPush = async () => {
    setPushBusy(true);
    try {
      await onPush();
    } finally {
      setPushBusy(false);
    }
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
      <button
        type="button"
        className="git-panel-toggle"
        aria-expanded={!panelCollapsed}
        title={panelCollapsed ? '展开源代码管理' : '收起源代码管理'}
        onClick={togglePanel}
      >
        <ChevronRight
          size={12}
          className={cn('section-caret', !panelCollapsed && 'is-open')}
        />
        <span className="git-panel-title">源代码管理</span>
      </button>
      <div className="git-panel-head-actions">
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
        <button
          type="button"
          className="git-ops-more"
          aria-label="更多提交操作"
          aria-haspopup="menu"
          aria-expanded={opsMenu !== null}
          title={head ? '更多提交操作' : '还没有提交可以操作'}
          disabled={!head}
          onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setOpsMenu({ x: rect.right - 176, y: rect.bottom + 6 });
          }}
        >
          <MoreHorizontal size={13} />
        </button>
      </div>
    </header>
  );

  if (!status) {
    return (
      <section className="git-panel">
        {header}
        <div className={cn('git-panel-body', panelCollapsed && 'is-hidden')}>
          <p className="git-panel-hint">正在读取 Git 状态…</p>
        </div>
      </section>
    );
  }

  if (!status.ok) {
    return (
      <section className="git-panel">
        {header}
        <div className={cn('git-panel-body', panelCollapsed && 'is-hidden')}>
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
        </div>
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
          <button
            type="button"
            className="git-resolve-btn"
            title="在编辑器中解决冲突"
            onClick={() => onOpenInEditor(change)}
          >
            解决冲突
          </button>
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

        <div className="git-sync-actions">
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

          {showBarPush ? (
            <button
              type="button"
              className="git-push-button"
              title={`本地有 ${status.ahead} 个提交待推送`}
              disabled={pushBusy || pullBusy}
              onClick={runBarPush}
            >
              <ArrowUp size={12} className={pushBusy ? 'is-spinning' : undefined} />
              <span>{pushBusy ? '推送中…' : '推送'}</span>
            </button>
          ) : null}
        </div>
      </div>

      {branchMenuOpen ? (
        <BranchPickerModal
          branches={branches}
          current={currentBranch || status.branch}
          busy={branchBusy}
          onSelect={onCheckout}
          onMerge={onMerge}
          onMergeInto={() => setMergeOpen(true)}
          onCreate={() => setNewBranchOpen(true)}
          onClose={() => setBranchMenuOpen(false)}
        />
      ) : null}

      {mergeOpen ? (
        <MergeModal
          branches={branches}
          current={currentBranch || status.branch}
          busy={branchBusy}
          onClose={() => setMergeOpen(false)}
          onConfirm={(source, target) => {
            setMergeOpen(false);
            onMergeInto(source, target);
          }}
        />
      ) : null}

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

      {syncPrompt ? (
        <SyncDialog
          prompt={syncPrompt}
          busy={syncBusy}
          onChoose={onSyncChoice}
          onClose={onSyncClose}
        />
      ) : null}

      <div className={cn('git-panel-body', panelCollapsed && 'is-hidden')}>
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
              title={hasConflicts ? '有冲突需要先解决' : '全部放弃'}
              disabled={groupBusy || hasConflicts}
              onClick={() => setConfirmDiscard({ kind: 'all' })}
            >
              <Trash2 size={13} />
            </button>
            <button
              type="button"
              className="git-group-action"
              title={hasConflicts ? '有冲突需要先解决' : '全部暂存'}
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
      </div>

      <div className="git-stash">
        <button
          type="button"
          className="git-group-head git-stash-toggle"
          aria-expanded={!stashCollapsed}
          title={stashCollapsed ? '展开暂存的改动' : '收起暂存的改动'}
          onClick={toggleStash}
        >
          <ChevronRight
            size={12}
            className={cn('section-caret', !stashCollapsed && 'is-open')}
          />
          <span className="git-stash-title">暂存的改动</span>
          <span className="git-group-count">{stashes.length}</span>
        </button>
        {stashCollapsed ? null : stashes.length === 0 ? (
          <p className="git-panel-hint">没有收起的改动</p>
        ) : (
          <ul className="git-stash-list">
            {stashes.map((stash) => (
              <li key={`${stash.ref}:${stash.message}`} className="git-stash-item">
                <span className="git-stash-ref">{stash.ref}</span>
                <span className="git-stash-message" title={stash.message}>
                  {stash.message}
                </span>
                <span className="git-stash-meta">{stash.when}</span>
                <button
                  type="button"
                  className="git-row-action"
                  title="恢复"
                  // stash ref 是位置型的，任何 stash 操作（含收起）在飞时都要锁住所有行
                  disabled={stashBusy !== null || stashSaving}
                  onClick={() => void onStashPop(stash.ref)}
                >
                  <Undo2 size={13} />
                </button>
                <button
                  type="button"
                  className="git-row-action"
                  title="丢弃"
                  disabled={stashBusy !== null || stashSaving}
                  onClick={() => setConfirmDropStash(stash.ref)}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {opsMenu ? (
        <PopupMenu
          state={{
            x: opsMenu.x,
            y: opsMenu.y,
            items: [
              {
                type: 'item',
                id: 'git-stash-save',
                label: stashSaving ? '收起中…' : '收起改动',
                icon: <Archive size={14} />,
                title: head ? '把全部未提交改动收进 stash' : '还没有提交，无法收起改动',
                disabled: !status.hasChanges || !head || stashSaving || stashBusy !== null,
                onSelect: async () => {
                  setStashSaving(true);
                  try {
                    if (await onStashSave()) setStashCollapsed(false);
                  } finally {
                    setStashSaving(false);
                  }
                },
              },
              { type: 'separator', id: 'git-ops-sep' },
              {
                type: 'item',
                id: 'git-undo-commit',
                label: undoBusy ? '撤销中…' : '撤销提交',
                icon: <RotateCcw size={14} />,
                title: '撤销最后一次提交，改动回到暂存区',
                disabled: !head || undoBusy || headBusy || busy,
                onSelect: async () => {
                  setHeadBusy(true);
                  try {
                    const fresh = await onRefreshHead();
                    if (fresh) setConfirmUndo(fresh);
                  } finally {
                    setHeadBusy(false);
                  }
                },
              },
              {
                type: 'item',
                id: 'git-amend-commit',
                label: '修改提交',
                icon: <Pencil size={14} />,
                title: '修改最后一次提交的信息',
                disabled: !head || amendBusy || headBusy || busy,
                onSelect: async () => {
                  setHeadBusy(true);
                  try {
                    const fresh = await onRefreshHead();
                    if (fresh) setAmendHead(fresh);
                  } finally {
                    setHeadBusy(false);
                  }
                },
              },
            ] as MenuEntry[],
          }}
          onClose={() => setOpsMenu(null)}
        />
      ) : null}

      {confirmDropStash ? (
        <ConfirmDialog
          title="丢弃 stash"
          confirmLabel="确定丢弃"
          message={
            <>
              <p>丢弃「{confirmDropStash}」？丢弃后无法恢复。</p>
            </>
          }
          onClose={() => setConfirmDropStash(null)}
          onConfirm={async () => {
            const ref = confirmDropStash;
            setConfirmDropStash(null);
            if (ref) await onStashDrop(ref);
          }}
        />
      ) : null}

      {confirmUndo ? (
        <ConfirmDialog
          title="撤销提交"
          confirmLabel="确定撤销"
          message={
            <>
              <p>撤销最后一次提交？改动会回到暂存区。</p>
              {confirmUndo.pushed ? (
                <p className="confirm-note">
                  这个提交已经推送过，撤销后需要强推才能同步远端。
                </p>
              ) : null}
            </>
          }
          onClose={() => setConfirmUndo(null)}
          onConfirm={async () => {
            setConfirmUndo(null);
            setUndoBusy(true);
            try {
              const restored = await onUndoCommit();
              if (restored !== null) {
                setMessage(restored);
                setPhase('idle');
              }
            } finally {
              setUndoBusy(false);
            }
          }}
        />
      ) : null}

      {amendHead ? (
        <AmendModal
          current={amendHead.message}
          stagedCount={status.stagedCount}
          pushed={amendHead.pushed}
          busy={amendBusy}
          onClose={() => setAmendHead(null)}
          onConfirm={async (next) => {
            setAmendBusy(true);
            try {
              if (await onAmend(next)) {
                setAmendHead(null);
                setPhase('idle');
                setMessage(next);
                setCommittedMessage('');
              }
            } finally {
              setAmendBusy(false);
            }
          }}
        />
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
        <button
          type="button"
          className="git-group-head git-history-toggle"
          aria-expanded={!historyCollapsed}
          title={historyCollapsed ? '展开最近提交' : '收起最近提交'}
          onClick={toggleHistory}
        >
          <ChevronRight
            size={12}
            className={cn('section-caret', !historyCollapsed && 'is-open')}
          />
          <span className="git-history-title">最近提交</span>
        </button>
        {historyCollapsed ? null : commits.length === 0 ? (
          <p className="git-panel-hint">还没有提交记录</p>
        ) : (
          <ul className="git-history-list">
            {commits.map((commit) => (
              <li key={commit.hash} className="git-history-item">
                <button
                  type="button"
                  className="git-history-button"
                  title={`${commit.short} · ${commit.subject}`}
                  onClick={() => onOpenCommit(commit)}
                >
                  <span className="git-history-subject">{commit.subject}</span>
                  <span className="git-history-meta">
                    {commit.short} · {commit.when}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
