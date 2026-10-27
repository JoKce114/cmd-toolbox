import { useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { toErrorMessage } from '../lib';
import { Modal } from './Modal';

type ConfirmDialogProps = {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
};

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busyLabel = '处理中…',
  onClose,
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm();
    } catch (confirmError) {
      setError(toErrorMessage(confirmError));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      icon={<AlertTriangle size={17} />}
      width={420}
      onClose={onClose}
      closeDisabled={busy}
    >
      <div className="confirm-message">{message}</div>
      {error ? (
        <div className="field-error confirm-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="modal-footer">
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button type="button" className="btn btn-danger" onClick={confirm} disabled={busy}>
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
