import { useCallback, useEffect, useRef, useState } from 'react';
import { Save, Search, X } from 'lucide-react';
import { cn, toErrorMessage } from '../lib';
import { useEditorFiles } from '../useEditorFiles';
import { FileTree } from './FileTree';
import { SearchPanel } from './SearchPanel';
import { CodeMirrorHost } from './CodeMirrorHost';
import type { Group, Tab } from '../types';
import type { TerminalThemeMode } from '../theme';
import type { KeyBindingMap } from '../editorKeymap';
import type { ToastKind } from './Toast';

const ENCODING_LABEL: Record<string, string> = {
  utf8: 'UTF-8',
  utf8bom: 'UTF-8 BOM',
  utf16le: 'UTF-16 LE',
  utf16be: 'UTF-16 BE',
  gbk: 'GBK',
};

export type EditorPaneProps = {
  tab: Tab;
  group: Group;
  active: boolean;
  onClose: (tab: Tab) => void;
  onToast: (message: string, kind?: ToastKind) => void;
  onTitleChange: (title: string) => void;
  onDirtyChange: (tabId: string, dirty: boolean) => void;
  themeMode: TerminalThemeMode;
  wordWrap: boolean;
  tabSize: number;
  indentWithSpaces: boolean;
  keybindings: KeyBindingMap;
};

export function EditorPane({
  tab,
  group,
  active,
  onClose,
  onToast,
  onTitleChange,
  onDirtyChange,
  themeMode,
  wordWrap,
  tabSize,
  indentWithSpaces,
  keybindings,
}: EditorPaneProps) {
  const onError = useCallback((message: string) => onToast(message, 'error'), [onToast]);
  const {
    files,
    openPaths,
    activePath,
    active: file,
    hasDirty,
    open,
    update,
    save,
    close,
    setActivePath,
  } = useEditorFiles(group, onError);

  const [conflictCount, setConflictCount] = useState(0);
  const [hadConflict, setHadConflict] = useState(false);
  const [markingResolved, setMarkingResolved] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [pendingClose, setPendingClose] = useState<string | null>(null);

  const rootRef = useRef<HTMLElement>(null);
  const fileRef = useRef(file);
  fileRef.current = file;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  // 回调每次渲染都是新函数：放进 ref，避免 effect 因函数身份变化而反复触发
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  // 页签的 filePath 会变（上层用同一个编辑器页签顶替新文件），
  // 所以要比对「上次已应用的路径」而不是只在挂载时读一次。
  const appliedPathRef = useRef('');
  useEffect(() => {
    const next = tab.filePath || '';
    if (!next || next === appliedPathRef.current) return;
    appliedPathRef.current = next;
    void open(next);
  }, [tab.filePath, open]);

  useEffect(() => {
    const base = activePath ? activePath.split('/').pop() || '编辑器' : '编辑器';
    onTitleChangeRef.current(`${group.name} · ${base}${hasDirty ? ' •' : ''}`);
  }, [activePath, hasDirty, group.name]);

  useEffect(() => {
    onDirtyChangeRef.current(tab.id, hasDirty);
  }, [tab.id, hasDirty]);

  useEffect(() => {
    setConflictCount(0);
    setHadConflict(false);
  }, [activePath]);

  useEffect(() => {
    if (conflictCount > 0) setHadConflict(true);
  }, [conflictCount]);

  useEffect(() => {
    // 保存后（dirty 变回 false）结束本次冲突处理，避免之后的普通编辑
    // 又让「冲突已全部处理」提示重新出现
    if (!file.dirty) setHadConflict(false);
  }, [file.dirty]);

  // 解析器对畸形标记会整体返回空；此时用原始内容兜底，避免把残留标记当成「已全部处理」
  const unrecognizedConflict = conflictCount === 0 && /^<{7}/m.test(file.content);

  useEffect(() => {
    return () => onDirtyChangeRef.current(tab.id, false);
  }, [tab.id]);

  const handleSave = useCallback(async () => {
    const current = fileRef.current;
    const target = activePathRef.current;
    if (!target) return;
    if (current.readOnly) {
      onToast('该文件为只读，无法保存', 'error');
      return;
    }
    const ok = await save(target);
    if (ok) onToast('已保存', 'success');
  }, [onToast, save]);

  const markResolved = useCallback(async () => {
    const target = activePathRef.current;
    if (!target) return;
    setMarkingResolved(true);
    try {
      await window.api.git.stage(group.path, [target]);
      onToast(`已标记「${target}」为已解决`, 'success');
      setHadConflict(false);
    } catch (error) {
      onToast(toErrorMessage(error), 'error');
    } finally {
      setMarkingResolved(false);
    }
  }, [group.path, onToast]);

  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'f') {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === 'w') {
        event.preventDefault();
        requestCloseTab(activePathRef.current);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && key === 's') {
        event.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, handleSave]);

  const requestCloseTab = (relPath: string) => {
    if (!relPath) return;
    const target = files[relPath];
    if (target?.dirty) {
      setPendingClose(relPath);
      return;
    }
    close(relPath);
  };

  const requestOpen = (relPath: string) => {
    void open(relPath);
  };

  const requestClose = () => {
    if (hasDirty) {
      const names = openPaths.filter((item) => files[item].dirty).join('、');
      const ok = window.confirm(`「${names}」有未保存的修改，关闭将丢失。是否继续？`);
      if (!ok) return;
    }
    onClose(tab);
  };

  const encodingLabel = ENCODING_LABEL[file.encoding] || file.encoding;

  return (
    <section
      ref={rootRef}
      className={`terminal-pane editor-pane theme-${themeMode}${active ? '' : ' is-hidden'}`}
    >
      <header className="pane-header">
        <span className="pane-path" title={activePath || group.path}>
          {activePath || group.name}
        </span>
        {conflictCount > 0 ? (
          <span
            className="editor-conflict-badge"
            title={`还有 ${conflictCount} 处冲突未处理`}
          >
            冲突 {conflictCount} 处
          </span>
        ) : null}
        {unrecognizedConflict ? (
          <span className="editor-conflict-badge" title="文件里还有无法识别的冲突标记">
            存在未识别冲突标记
          </span>
        ) : null}
        <span className="editor-encoding">{activePath ? encodingLabel : ''}</span>
        <button
          type="button"
          className={`icon-btn${file.saving ? ' is-saving' : ''}`}
          title="保存 (Ctrl+S)"
          disabled={file.saving || file.readOnly || !file.dirty}
          onClick={() => void handleSave()}
        >
          {file.saving ? <span className="editor-saving">保存中…</span> : <Save size={14} />}
        </button>
        <button
          type="button"
          className="icon-btn"
          title="在项目中搜索 (Ctrl+Shift+F)"
          onClick={() => setSearchOpen(true)}
        >
          <Search size={14} />
        </button>
        <button type="button" className="icon-btn" title="关闭" onClick={requestClose}>
          <X size={14} />
        </button>
      </header>

      {openPaths.length > 0 ? (
        <div className="editor-tabs">
          {openPaths.map((relPath) => (
            <div
              key={relPath}
              className={cn('editor-tab', relPath === activePath && 'active')}
            >
              <button
                type="button"
                className="editor-tab-name"
                title={relPath}
                onClick={() => setActivePath(relPath)}
              >
                {relPath.split('/').pop()}
                {files[relPath].dirty ? <span className="editor-tab-dot">•</span> : null}
              </button>
              <button
                type="button"
                className="editor-tab-close"
                title="关闭该文件"
                onClick={() => requestCloseTab(relPath)}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {file.readOnly && activePath ? (
        <p className="editor-notice">该文件为只读（二进制、过大或无法解码）</p>
      ) : null}

      {hadConflict && conflictCount === 0 && !unrecognizedConflict && file.dirty ? (
        <p className="editor-notice editor-notice-done">
          冲突已全部处理。按 Ctrl+S 保存，然后点「暂存」标记为已解决。
        </p>
      ) : null}

      {hadConflict && conflictCount === 0 && !unrecognizedConflict && !file.dirty && !file.readOnly && activePath ? (
        <div className="editor-notice editor-notice-done editor-resolve-bar">
          <span>冲突已全部处理并保存，标记为已解决后即可提交。</span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={markingResolved}
            onClick={() => void markResolved()}
          >
            {markingResolved ? '标记中…' : '标记为已解决'}
          </button>
        </div>
      ) : null}

      <div className="editor-body">
        {searchOpen ? (
          <SearchPanel
            group={group}
            onOpen={(relPath) => {
              requestOpen(relPath);
              setSearchOpen(false);
            }}
            onClose={() => setSearchOpen(false)}
            onError={onError}
          />
        ) : (
          <FileTree group={group} activePath={activePath} onOpen={requestOpen} onError={onError} />
        )}
        <div className="editor-main">
          {activePath ? (
            <CodeMirrorHost
              value={file.content}
              filePath={activePath}
              readOnly={file.readOnly}
              themeMode={themeMode}
              wordWrap={wordWrap}
              tabSize={tabSize}
              indentWithSpaces={indentWithSpaces}
              keybindings={keybindings}
              onChange={(value) => update(activePath, value)}
              onConflictCountChange={setConflictCount}
            />
          ) : (
            <p className="editor-placeholder">从左侧选择文件</p>
          )}
        </div>
      </div>

      {pendingClose ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card editor-confirm">
            <p className="confirm-message">
              「{pendingClose}」有未保存的修改，关闭将丢失。是否继续？
            </p>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setPendingClose(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const target = pendingClose;
                  setPendingClose(null);
                  if (target) close(target);
                }}
              >
                继续
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
