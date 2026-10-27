import { useState } from 'react';
import { Modal } from './Modal';

export type NewBranchModalProps = {
  branches: string[];
  current: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (name: string, startPoint: string) => void;
};

export function NewBranchModal({
  branches,
  current,
  busy,
  onClose,
  onConfirm,
}: NewBranchModalProps) {
  const [name, setName] = useState('');
  // 空仓库还没有任何提交，不能把当前分支名当作起点
  const [startPoint, setStartPoint] = useState(branches.length > 0 ? current : '');

  const canSubmit = name.trim().length > 0 && !busy;

  return (
    <Modal
      title="新建分支"
      subtitle="从选中分支创建并立即切换过去"
      onClose={onClose}
      closeDisabled={busy}
    >
      <div className="modal-form">
        <label className="field">
          <span className="field-label">分支名称</span>
          <input
            id="new-branch-name"
            value={name}
            autoFocus
            spellCheck={false}
            placeholder="feature/新功能"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canSubmit) onConfirm(name.trim(), startPoint);
            }}
          />
        </label>

        {branches.length > 0 ? (
          <label className="field">
            <span className="field-label">起点分支</span>
            <select
              id="new-branch-start"
              value={startPoint}
              onChange={(event) => setStartPoint(event.target.value)}
            >
              {branches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="field-label">仓库尚无提交，将直接创建新分支</p>
        )}

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSubmit}
            onClick={() => onConfirm(name.trim(), startPoint)}
          >
            {busy ? '创建中…' : '创建并切换'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
