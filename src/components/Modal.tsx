import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

type ModalProps = {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  closeDisabled?: boolean;
  width?: number;
};

export function Modal({
  title,
  subtitle,
  icon,
  children,
  onClose,
  closeDisabled = false,
  width = 460,
}: ModalProps) {
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || closeDisabled) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [closeDisabled, onClose]);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const preferred = card.querySelector<HTMLElement>('[data-autofocus]');
    const fallback = card.querySelector<HTMLElement>(
      'input, textarea, select, button:not([aria-label="关闭"])',
    );
    (preferred || fallback)?.focus();
  }, []);

  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !closeDisabled) onClose();
      }}
    >
      <div
        className="modal-card"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={cardRef}
      >
        <div className="modal-head">
          {icon ? <div className="modal-icon">{icon}</div> : null}
          <div className="modal-heading">
            <h2 className="modal-title" id={titleId}>
              {title}
            </h2>
            {subtitle ? <p className="modal-subtitle">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            className="icon-btn modal-close"
            aria-label="关闭"
            onClick={onClose}
            disabled={closeDisabled}
          >
            <X size={15} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
