import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MenuState } from '../types';

const EDGE = 8;

export function PopupMenu({ state, onClose }: { state: MenuState; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: state.x, top: state.y });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const left = Math.min(
      Math.max(EDGE, state.x),
      Math.max(EDGE, window.innerWidth - rect.width - EDGE),
    );
    const preferredTop =
      state.y + rect.height > window.innerHeight - EDGE
        ? state.y - rect.height
        : state.y;
    const top = Math.min(
      Math.max(EDGE, preferredTop),
      Math.max(EDGE, window.innerHeight - rect.height - EDGE),
    );
    setPosition({ left, top });
  }, [state]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="popup-menu"
      role="menu"
      ref={menuRef}
      style={{ left: position.left, top: position.top }}
    >
      {state.items.map((entry) => {
        if (entry.type === 'separator') {
          return <div className="popup-separator" key={entry.id} role="separator" />;
        }
        if (entry.type === 'label') {
          return (
            <div className="popup-label" key={entry.id}>
              {entry.label}
            </div>
          );
        }
        return (
          <button
            type="button"
            role="menuitem"
            className={entry.danger ? 'popup-item danger' : 'popup-item'}
            key={entry.id}
            title={entry.title}
            disabled={entry.disabled}
            onClick={() => {
              if (entry.disabled) return;
              onClose();
              entry.onSelect();
            }}
          >
            {entry.icon ? <span className="popup-icon">{entry.icon}</span> : null}
            <span className="popup-text">{entry.label}</span>
            {entry.shortcut ? <span className="popup-shortcut">{entry.shortcut}</span> : null}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
