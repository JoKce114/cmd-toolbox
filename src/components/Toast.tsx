import { createPortal } from 'react-dom';
import { Check, CircleAlert, Info } from 'lucide-react';

export type ToastKind = 'info' | 'success' | 'error';

export type ToastItem = {
  id: number;
  message: string;
  kind: ToastKind;
};

const ICONS = {
  success: Check,
  error: CircleAlert,
  info: Info,
};

export function ToastViewport({ items }: { items: ToastItem[] }) {
  return createPortal(
    <div className="toast-viewport" role="status" aria-live="polite">
      {items.map((item) => {
        const Icon = ICONS[item.kind];
        return (
          <div className={`toast toast-${item.kind}`} key={item.id}>
            <Icon size={14} />
            <span>{item.message}</span>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
