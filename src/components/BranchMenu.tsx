import { Check, GitMerge, Plus } from 'lucide-react';
import { cn } from '../lib';

export type BranchMenuProps = {
  branches: string[];
  current: string;
  busy: boolean;
  onSelect: (branch: string) => void;
  onMerge: (branch: string) => void;
  onCreate: () => void;
  onClose: () => void;
};

export function BranchMenu({
  branches,
  current,
  busy,
  onSelect,
  onMerge,
  onCreate,
  onClose,
}: BranchMenuProps) {
  return (
    <div className="branch-menu" role="menu" onMouseDown={(event) => event.stopPropagation()}>
      <div className="branch-menu-list">
        {branches.map((branch) => {
          const isCurrent = branch === current;
          return (
            <div key={branch} className={cn('branch-menu-row', isCurrent && 'is-current')}>
              <button
                type="button"
                className="branch-menu-name"
                role="menuitem"
                disabled={isCurrent || busy}
                title={isCurrent ? '当前分支' : `切换到 ${branch}`}
                onClick={() => {
                  onSelect(branch);
                  onClose();
                }}
              >
                <span className="branch-menu-text">{branch}</span>
                {isCurrent ? <Check size={12} /> : null}
              </button>
              {isCurrent ? null : (
                <button
                  type="button"
                  className="branch-menu-merge"
                  title={`把 ${branch} 合并到 ${current}`}
                  disabled={busy}
                  onClick={() => {
                    onMerge(branch);
                    onClose();
                  }}
                >
                  <GitMerge size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="branch-menu-create"
        role="menuitem"
        disabled={busy}
        onClick={() => {
          onCreate();
          onClose();
        }}
      >
        <Plus size={13} />
        <span>新建分支…</span>
      </button>
    </div>
  );
}
