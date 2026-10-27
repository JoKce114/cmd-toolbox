import { useState } from 'react';
import { Settings } from 'lucide-react';
import { Modal } from './Modal';
import type { AppPrefs } from '../prefs';

type SettingsModalProps = {
  prefs: AppPrefs;
  onClose: () => void;
  onSave: (prefs: AppPrefs) => void;
};

export function SettingsModal({ prefs, onClose, onSave }: SettingsModalProps) {
  const [fontSize, setFontSize] = useState(prefs.fontSize);
  const [copyOnSelect, setCopyOnSelect] = useState(prefs.copyOnSelect);

  return (
    <Modal title="设置" subtitle="终端与操作习惯" icon={<Settings size={18} />} onClose={onClose} width={420}>
      <label className="settings-row">
        <span>终端字号</span>
        <span className="settings-inline">
          <input
            type="range"
            min={11}
            max={20}
            value={fontSize}
            onChange={(event) => setFontSize(Number(event.target.value))}
          />
          <em>{fontSize}px</em>
        </span>
      </label>
      <label className="settings-row">
        <span>选中即复制</span>
        <input
          type="checkbox"
          checked={copyOnSelect}
          onChange={(event) => setCopyOnSelect(event.target.checked)}
        />
      </label>
      <p className="settings-hint">Ctrl+滚轮也可以改字号。Ctrl+F 在终端或浏览器里查找。</p>
      <div className="modal-footer">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onSave({ fontSize, copyOnSelect })}
        >
          保存
        </button>
      </div>
    </Modal>
  );
}
