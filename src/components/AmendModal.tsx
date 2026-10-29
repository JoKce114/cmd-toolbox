import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { Modal } from './Modal';

export type AmendModalProps = {
  current: string;
  stagedCount: number;
  pushed: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: (message: string) => Promise<void>;
};

export function AmendModal({
  current,
  stagedCount,
  pushed,
  busy,
  onClose,
  onConfirm,
}: AmendModalProps) {
  const [message, setMessage] = useState(current);
  const [submitting, setSubmitting] = useState(false);
  const canSave = message.trim().length > 0 && !submitting && !busy;

  return (
    <Modal
      title="修改提交"
      subtitle="改写最后一次提交"
      icon={<Pencil size={18} />}
      onClose={onClose}
      closeDisabled={submitting}
    >
      <label className="modal-field">
        <span className="modal-label">提交信息</span>
        <textarea
          id="amend-message"
          className="modal-textarea"
          rows={4}
          value={message}
          spellCheck={false}
          onChange={(event) => setMessage(event.target.value)}
        />
      </label>
      {stagedCount > 0 ? (
        <p className="modal-note">当前 {stagedCount} 项暂存改动会并入这次提交。</p>
      ) : null}
      {pushed ? (
        <p className="modal-warning">这个提交已经推送过，修改后需要强推才能同步远端。</p>
      ) : null}
      <div className="modal-footer">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSave}
          onClick={async () => {
            setSubmitting(true);
            try {
              await onConfirm(message.trim());
            } finally {
              setSubmitting(false);
            }
          }}
        >
          {submitting ? '保存中…' : '保存修改'}
        </button>
      </div>
    </Modal>
  );
}
