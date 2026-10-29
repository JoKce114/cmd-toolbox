import { useState } from 'react';
import {
  Download,
  FileCode2,
  Info,
  Keyboard,
  RefreshCw,
  RotateCcw,
  Settings,
  Terminal,
  X,
} from 'lucide-react';
import { Modal } from './Modal';
import {
  DEFAULT_KEYBINDINGS,
  EDITOR_ACTION_LABEL,
  RESERVED_BINDINGS,
  normalizeCombo,
} from '../editorKeymap';
import type { EditorActionId, KeyBindingMap } from '../editorKeymap';
import type { AppPrefs } from '../prefs';
import type { UpdateCheckResult, UpdaterState } from '../types';

type SettingsModalProps = {
  prefs: AppPrefs;
  version?: string;
  update?: UpdateCheckResult | null;
  updateBusy?: boolean;
  updater?: UpdaterState;
  onCheckUpdate?: () => void;
  onStartUpdate?: () => void;
  onInstallUpdate?: () => void;
  onClose: () => void;
  onSave: (prefs: AppPrefs) => void;
};

type TabId = 'about' | 'terminal' | 'editor' | 'keys';

const TABS: { id: TabId; label: string; icon: typeof Info }[] = [
  { id: 'about', label: '关于', icon: Info },
  { id: 'terminal', label: '终端', icon: Terminal },
  { id: 'editor', label: '编辑器', icon: FileCode2 },
  { id: 'keys', label: '快捷键', icon: Keyboard },
];

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

function updaterStatusText(updater: UpdaterState | undefined): string {
  if (!updater) return '';
  switch (updater.phase) {
    case 'downloading':
      return `正在下载安装包 ${updater.percent}%`;
    case 'downloaded':
      return '安装包已下载完成，重启应用即可完成升级';
    case 'error':
      return updater.message;
    case 'unsupported':
      return '开发模式下不支持自动更新，请前往下载页手动安装';
    default:
      return '下载安装包后自动重启完成升级';
  }
}

export function SettingsModal({
  prefs,
  version,
  update,
  updateBusy = false,
  updater,
  onCheckUpdate,
  onStartUpdate,
  onInstallUpdate,
  onClose,
  onSave,
}: SettingsModalProps) {
  const [tab, setTab] = useState<TabId>('about');
  const [terminalFontSize, setTerminalFontSize] = useState(prefs.terminalFontSize);
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
      width={560}
    >
      <div className="settings-tabs" role="tablist" aria-label="设置分类">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`settings-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`settings-panel-${id}`}
            className={`settings-tab${tab === id ? ' is-active' : ''}`}
            onClick={() => setTab(id)}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      <div
        className="settings-body"
        role="tabpanel"
        id={`settings-panel-${tab}`}
        aria-labelledby={`settings-tab-${tab}`}
      >
        {tab === 'about' ? (
          <section className="settings-group">
            <div className="settings-item">
              <div className="settings-item-text">
                <span className="settings-item-label">
                  Cmd Toolbox {version ? `v${version}` : ''}
                </span>
                <span className="settings-item-desc">
                  {updateStatusText(update, updateBusy)}
                </span>
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
                  <span className="settings-item-label">发现新版本 {update.latest}</span>
                  <span className="settings-item-desc">
                    {updater && updater.phase !== 'unsupported'
                      ? updaterStatusText(updater)
                      : '在浏览器打开 Release 页面，下载安装包后安装'}
                  </span>
                </div>
                {updater && updater.phase !== 'unsupported' ? (
                  updater.phase === 'downloaded' ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={onInstallUpdate}
                    >
                      <RotateCcw size={13} />
                      重启并安装
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={updater.phase === 'downloading'}
                      onClick={onStartUpdate}
                    >
                      <RefreshCw size={13} />
                      {updater.phase === 'downloading'
                        ? `下载中 ${updater.percent}%`
                        : updater.phase === 'error'
                          ? '重试'
                          : '立即更新'}
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void window.api.shell.openExternal(update.url)}
                  >
                    <Download size={13} />
                    前往下载
                  </button>
                )}
              </div>
            ) : null}

            {update?.ok && update.hasUpdate && updater && updater.phase !== 'unsupported' ? (
              <div className="settings-item">
                <div className="settings-item-text">
                  <span className="settings-item-label">手动下载</span>
                  <span className="settings-item-desc">
                    自动更新失败时，可以在浏览器打开 Release 页面手动安装
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void window.api.shell.openExternal(update.url)}
                >
                  <Download size={13} />
                  前往下载
                </button>
              </div>
            ) : null}

            <p className="settings-hint">
              更新说明取自 GitHub Release，发布新版本后可在「检查更新」里看到。
            </p>
          </section>
        ) : null}

        {tab === 'terminal' ? (
          <section className="settings-group">
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
                  value={terminalFontSize}
                  onChange={(event) => setTerminalFontSize(Number(event.target.value))}
                />
                <em>{terminalFontSize}px</em>
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
        ) : null}

        {tab === 'editor' ? (
          <section className="settings-group">
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
              <Toggle
                checked={editorIndentWithSpaces}
                onChange={setEditorIndentWithSpaces}
              />
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
        ) : null}

        {tab === 'keys' ? (
          <section className="settings-group">
            <div className="settings-group-head">
              <span className="settings-panel-note">点击按键框后按下组合键即可修改</span>
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
                    onBlur={() =>
                      setRecording((current) => (current === action ? null : current))
                    }
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
              保存、关闭页签等应用级快捷键不可改。Ctrl + F 在终端或浏览器里查找，
              Ctrl + Shift + F 在项目里搜索。
            </p>
          </section>
        ) : null}
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
              ...prefs,
              terminalFontSize,
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
