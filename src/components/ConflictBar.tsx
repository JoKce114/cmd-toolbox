import type { ConflictChoice } from '../conflictParser';

export type ConflictBarProps = {
  oursLabel: string;
  theirsLabel: string;
  onResolve: (choice: ConflictChoice) => void;
};

export function ConflictBar({ oursLabel, theirsLabel, onResolve }: ConflictBarProps) {
  return (
    <div className="conflict-bar">
      <button
        type="button"
        className="conflict-action"
        title={`保留「${oursLabel}」的内容`}
        onClick={() => onResolve('ours')}
      >
        采用当前
      </button>
      <button
        type="button"
        className="conflict-action"
        title={`保留「${theirsLabel}」的内容`}
        onClick={() => onResolve('theirs')}
      >
        采用传入
      </button>
      <button
        type="button"
        className="conflict-action"
        title="两段内容都保留"
        onClick={() => onResolve('both')}
      >
        两者都保留
      </button>
    </div>
  );
}
