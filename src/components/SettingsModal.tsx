import { useState } from 'react';
import { Settings } from 'lucide-react';
import { Modal } from './Modal';
import type { AppPrefs } from '../prefs';

type SettingsModalProps = {
  prefs: AppPrefs;
  onClose: () => void;
  onSave: (prefs: AppPrefs) => void;
};

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`settings-switch${checked ? ' is-on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-switch-knob" />
    </button>
  );
}

export function SettingsModal({ prefs, onClose, onSave }: SettingsModalProps) {
  const [fontSize, setFontSize] = useState(prefs.fontSize);
  const [copyOnSelect, setCopyOnSelect] = useState(prefs.copyOnSelect);
  const [editorWordWrap, setEditorWordWrap] = useState(prefs.editorWordWrap);

  return (
    <Modal
      title="设置"
      subtitle="终端与编辑器偏好"
      icon={<Settings size={18} />}
      onClose={onClose}
      width={460}
    >
      <div className="settings-body">
        <section className="settings-group">
          <h3 className="settings-group-title">终端</h3>

          <div className="settings-item">
            <div className="settings-item-text">
              <span className="settings-item-label">终端字号</span>
              <span className="settings-item-desc">Ctrl + 滚轮也可以随时调整</span>
            </div>
            <div className="settings-slider">
              <input
                type="range"
                min={11}
                max={20}
                value={fontSize}
                onChange={(event) => setFontSize(Number(event.target.value))}
              />
              <em>{fontSize}px</em>
            </div>
          </div>

          <div className="settings-item">
            <div className="settings-item-text">
              <span className="settings-item-label">选中即复制</span>
              <span className="settings-item-desc">在终端里选中文字后自动写入剪贴板</span>
            </div>
            <Toggle checked={copyOnSelect} onChange={setCopyOnSelect} />
          </div>
        </section>

        <section className="settings-group">
          <h3 className="settings-group-title">编辑器</h3>

          <div className="settings-item">
            <div className="settings-item-text">
              <span className="settings-item-label">自动换行</span>
              <span className="settings-item-desc">长行超出宽度时折到下一行显示</span>
            </div>
            <Toggle checked={editorWordWrap} onChange={setEditorWordWrap} />
          </div>
        </section>

        <p className="settings-hint">Ctrl + F 在终端或浏览器里查找，Ctrl + Shift + F 在项目里搜索。</p>
      </div>

      <div className="modal-footer">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onSave({ fontSize, copyOnSelect, editorWordWrap })}
        >
          保存
        </button>
      </div>
    </Modal>
  );
}
