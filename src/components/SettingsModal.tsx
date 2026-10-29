import { useState } from 'react';
import { Download, Settings, X } from 'lucide-react';
import { Modal } from './Modal';
import {
  DEFAULT_KEYBINDINGS,
  EDITOR_ACTION_LABEL,
  RESERVED_BINDINGS,
  normalizeCombo,
} from '../editorKeymap';
import type { EditorActionId, KeyBindingMap } from '../editorKeymap';
import type { AppPrefs } from '../prefs';
import type { UpdateCheckResult } from '../types';

type SettingsModalProps = {
  prefs: AppPrefs;
  version?: string;
  update?: UpdateCheckResult | null;
  updateBusy?: boolean;
  onCheckUpdate?: () => void;
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

// 把事件转成 CodeMirror 的键位写法，例如 Ctrl-Shift-k
function comboFromEvent(event: React.KeyboardEvent): string | null {
  // Ctrl+Shift+/ 在美式键盘上 event.key 是 "?"，统一成 "/" 才能和 CodeMirror 的键位匹配
  const key = event.code === 'Slash' || event.key === '?' ? '/' : event.key;
  if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') return null;
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return null;

  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  parts.push(key.length === 1 ? key.toLowerCase() : key);
  return normalizeCombo(parts.join('-'));
}

function updateStatusText(
  update: UpdateCheckResult | null | undefined,
  busy: boolean,
): string {
  if (busy) return '正在检查…';
  if (!update) return '点击右侧按钮检查是否有新版本';
  if (!update.ok) return update.message;
  if (update.hasUpdate) return '有新版本可用，见下方';
  if (!update.latest) return '还没有发布任何版本';
  return `已是最新版本（${update.current}）`;
}

export function SettingsModal({
  prefs,
  version,
  update,
  updateBusy = false,
  onCheckUpdate,
  onClose,
  onSave,
}: SettingsModalProps) {
  const [fontSize, setFontSize] = useState(prefs.fontSize);
  const [copyOnSelect, setCopyOnSelect] = useState(prefs.copyOnSelect);
  const [editorWordWrap, setEditorWordWrap] = useState(prefs.editorWordWrap);
  const [editorTabSize, setEditorTabSize] = useState(prefs.editorTabSize);
  const [editorIndentWithSpaces, setEditorIndentWithSpaces] = useState(
    prefs.editorIndentWithSpaces,
  );
  const [keybindings, setKeybindings] = useState<KeyBindingMap>({
    ...prefs.editorKeybindings,
  });
  const [recording, setRecording] = useState<EditorActionId | null>(null);
  const [bindingError, setBindingError] = useState<string>('');

  const updateBinding = (action: EditorActionId, combo: string) => {
    const normalized = normalizeCombo(combo);

    const reserved = RESERVED_BINDINGS.find(
      (item) => normalizeCombo(item.combo) === normalized,
    );
    if (reserved) {
      setBindingError(`${normalized} 已被「${reserved.reason}」占用`);
      return;
    }

    const conflict = (Object.keys(keybindings) as EditorActionId[]).find(
      (other) => other !== action && normalizeCombo(keybindings[other]) === normalized,
    );
    if (conflict) {
      setBindingError(
        `${normalized} 已绑定到「${EDITOR_ACTION_LABEL[conflict]}」，请先改掉它`,
      );
      return;
    }

    setBindingError('');
    setKeybindings((previous) => ({ ...previous, [action]: normalized }));
  };

  return (
    <Modal
      title="设置"
      subtitle="终端与编辑器偏好"
      icon={<Settings size={18} />}
      onClose={onClose}
      width={520}
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

          <div className="settings-item">
            <div className="settings-item-text">
              <span className="settings-item-label">缩进方式</span>
              <span className="settings-item-desc">
                当前为 {editorIndentWithSpaces ? `${editorTabSize} 个空格` : '制表符'}
              </span>
            </div>
            <Toggle checked={editorIndentWithSpaces} onChange={setEditorIndentWithSpaces} />
          </div>

          <div className="settings-item">
            <div className="settings-item-text">
              <span className="settings-item-label">缩进宽度</span>
              <span className="settings-item-desc">Tab 键一次缩进的空格数</span>
            </div>
            <select
              className="settings-select"
              value={editorTabSize}
              disabled={!editorIndentWithSpaces}
              onChange={(event) => setEditorTabSize(Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="settings-group">
          <div className="settings-group-head">
            <h3 className="settings-group-title">编辑器快捷键</h3>
            <button
              type="button"
              className="settings-reset-link"
              onClick={() => {
                setKeybindings({ ...DEFAULT_KEYBINDINGS });
                setBindingError('');
              }}
            >
              恢复默认
            </button>
          </div>

          <div className="settings-keys">
            {(Object.keys(EDITOR_ACTION_LABEL) as EditorActionId[]).map((action) => (
              <div className="settings-key-row" key={action}>
                <span className="settings-key-label">{EDITOR_ACTION_LABEL[action]}</span>
                <button
                  type="button"
                  className={`settings-key-input${recording === action ? ' is-recording' : ''}`}
                  onClick={() => {
                    setBindingError('');
                    setRecording(action);
                  }}
                  onBlur={() => setRecording((current) => (current === action ? null : current))}
                  onKeyDown={(event) => {
                    if (recording !== action) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.key === 'Escape') {
                      setRecording(null);
                      return;
                    }
                    const combo = comboFromEvent(event);
                    if (!combo) return;
                    updateBinding(action, combo);
                    setRecording(null);
                  }}
                >
                  {recording === action ? '按下快捷键…' : keybindings[action]}
                  {recording === action ? <X size={12} /> : null}
                </button>
              </div>
            ))}
          </div>

          {bindingError ? <p className="settings-key-error">{bindingError}</p> : null}
          <p className="settings-hint">
            点击右侧按键框后按下想要的组合键即可修改。保存、关闭页签等应用级快捷键不可改。
          </p>
        </section>

        <section className="settings-group">
          <h3 className="settings-group-title">关于</h3>

          <div className="settings-item">
            <div className="settings-item-text">
              <span className="settings-item-label">Cmd Toolbox {version ? `v${version}` : ''}</span>
              <span className="settings-item-desc">{updateStatusText(update, updateBusy)}</span>
            </div>
            {onCheckUpdate ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={updateBusy}
                onClick={onCheckUpdate}
              >
                {updateBusy ? '检查中…' : '检查更新'}
              </button>
            ) : null}
          </div>

          {update?.ok && update.hasUpdate ? (
            <div className="settings-item">
              <div className="settings-item-text">
                <span className="settings-item-label">
                  发现新版本 {update.latest}
                </span>
                <span className="settings-item-desc">
                  在浏览器打开 Release 页面，下载新的便携版覆盖即可
                </span>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void window.api.shell.openExternal(update.url)}
              >
                <Download size={13} />
                前往下载
              </button>
            </div>
          ) : null}
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
          onClick={() =>
            onSave({
              fontSize,
              copyOnSelect,
              editorWordWrap,
              editorTabSize,
              editorIndentWithSpaces,
              editorKeybindings: keybindings,
            })
          }
        >
          保存
        </button>
      </div>
    </Modal>
  );
}
