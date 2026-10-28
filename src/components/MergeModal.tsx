import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Modal } from './Modal';
import { BranchSelect } from './BranchSelect';

export type MergeModalProps = {
  branches: string[];
  current: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (source: string, target: string) => void;
};

export function MergeModal({ branches, current, busy, onClose, onConfirm }: MergeModalProps) {
  const others = branches.filter((branch) => branch !== current);
  const [source, setSource] = useState(others[0] || branches[0] || '');
  const [target, setTarget] = useState(current || branches[0] || '');

  const sameBranch = Boolean(source && target && source === target);
  const valid = Boolean(source && target) && !sameBranch && !busy;

  return (
    <Modal
      title="合并分支"
      subtitle="把源分支的提交合并到目标分支"
      onClose={onClose}
      closeDisabled={busy}
      width={520}
    >
      <div className="modal-form">
        <div className="field">
          <span className="field-label">源分支（合入）</span>
          <BranchSelect
            value={source}
            options={branches}
            disabled={busy}
            hintFor={(branch) => (branch === current ? '当前' : '')}
            onChange={(next) => {
              setSource(next);
              // 源分支换了之后，目标不能跟着撞车：若目标正好等于新源，换到当前分支
              if (next === target) setTarget(current || branches.find((b) => b !== next) || '');
            }}
          />
        </div>

        <div className="merge-arrow">
          <ArrowRight size={14} />
        </div>

        <div className="field">
          <span className="field-label">目标分支（合入到）</span>
          <BranchSelect
            value={target}
            options={branches}
            disabled={busy}
            hintFor={(branch) => (branch === current ? '当前' : '')}
            onChange={(next) => {
              setTarget(next);
              // 目标换成源分支时，把源挪开，避免两边相同
              if (next === source) {
                setSource(current && current !== next ? current : branches.find((b) => b !== next) || '');
              }
            }}
          />
        </div>

        {sameBranch ? (
          <p className="merge-warning">源分支和目标分支不能相同</p>
        ) : target && target !== current ? (
          <p className="merge-hint">
            目标不是当前分支：会先切换到 {target}，合并完成后自动切回 {current || '原分支'}。
          </p>
        ) : null}

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!valid}
            onClick={() => onConfirm(source, target)}
          >
            {busy ? '合并中…' : '开始合并'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
