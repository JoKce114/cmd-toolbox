import { useCallback, useEffect, useRef, useState } from 'react';
import { Save, Search, X } from 'lucide-react';
import { toErrorMessage } from '../lib';
import { useEditorFile } from '../useEditorFile';
import { FileTree } from './FileTree';
import { SearchPanel } from './SearchPanel';
import { CodeMirrorHost } from './CodeMirrorHost';
import type { Group, Tab } from '../types';
import type { TerminalThemeMode } from '../theme';
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
}: EditorPaneProps) {
  const onError = useCallback((message: string) => onToast(message, 'error'), [onToast]);
  const { file, open, update, save } = useEditorFile(group, onError);
  const [conflictCount, setConflictCount] = useState(0);
  const [hadConflict, setHadConflict] = useState(false);
  const [markingResolved, setMarkingResolved] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const fileRef = useRef(file);
  fileRef.current = file;
  const rootRef = useRef<HTMLElement>(null);
  // 回调每次渲染都是新函数：放进 ref，避免 effect 因函数身份变化而反复触发
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  useEffect(() => {
    if (
      tab.filePath &&
      tab.filePath !== file.relPath &&
      tab.filePath !== file.failedPath
    ) {
      void open(tab.filePath);
    }
  }, [tab.filePath, file.relPath, file.failedPath, open]);

  useEffect(() => {
    const base = file.relPath ? file.relPath.split('/').pop() || '编辑器' : '编辑器';
    onTitleChangeRef.current(`${group.name} · ${base}${file.dirty ? ' •' : ''}`);
  }, [file.relPath, file.dirty, group.name]);

  useEffect(() => {
    onDirtyChangeRef.current(tab.id, file.dirty);
  }, [tab.id, file.dirty]);

  useEffect(() => {
    setConflictCount(0);
  }, [file.relPath]);

  useEffect(() => {
    setHadConflict(false);
  }, [file.relPath]);

  useEffect(() => {
    if (conflictCount > 0) setHadConflict(true);
  }, [conflictCount]);

  useEffect(() => {
    // 保存或重新加载后（dirty 变回 false）结束本次冲突处理，避免之后的普通编辑
    // 又让「冲突已全部处理」提示重新出现。
    if (!file.dirty) setHadConflict(false);
  }, [file.dirty]);

  // 解析器对畸形标记会整体返回空；此时用原始内容兜底，避免把残留标记当成「已全部处理」。
  const unrecognizedConflict = conflictCount === 0 && /^<{7}/m.test(file.content);

  useEffect(() => {
    return () => onDirtyChangeRef.current(tab.id, false);
  }, [tab.id]);

  const requestOpen = (relPath: string) => {
    if (fileRef.current.dirty) {
      setPendingPath(relPath);
      return;
    }
    void open(relPath);
  };

  const markResolved = useCallback(async () => {
    const current = fileRef.current;
    if (!current.relPath) return;
    setMarkingResolved(true);
    try {
      await window.api.git.stage(group.path, [current.relPath]);
      onToast(`已标记「${current.relPath}」为已解决`, 'success');
      setHadConflict(false);
    } catch (error) {
      onToast(toErrorMessage(error), 'error');
    } finally {
      setMarkingResolved(false);
    }
  }, [group.path, onToast]);

  const handleSave = useCallback(async () => {
    if (fileRef.current.readOnly) {
      onToast('该文件为只读，无法保存', 'error');
      return;
    }
    const ok = await save();
    if (ok) onToast('已保存', 'success');
  }, [onToast, save]);

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
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && key === 's') {
        // 分屏时左右两侧的页签都可能“激活”；只处理焦点落在本窗格内的事件，避免双保存
        event.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active, handleSave]);

  const requestClose = () => {
    if (file.dirty) {
      const ok = window.confirm(`「${file.relPath}」有未保存的修改，关闭将丢失。是否继续？`);
      if (!ok) return;
    }
    onClose(tab);
  };

  return (
    <section
      ref={rootRef}
      className={`terminal-pane editor-pane theme-${themeMode}${active ? '' : ' is-hidden'}`}
    >
      <header className="pane-header">
        <span className="pane-path" title={file.relPath || group.path}>
          {file.relPath || group.name}
        </span>
        {conflictCount > 0 ? (
          <span className="editor-conflict-badge" title={`还有 ${conflictCount} 处冲突未处理`}>
            冲突 {conflictCount} 处
          </span>
        ) : unrecognizedConflict ? (
          <span
            className="editor-conflict-badge"
            title="文件里仍有无法识别的冲突标记，请手动检查"
          >
            存在未识别冲突标记
          </span>
        ) : null}
        <span className="editor-encoding">{ENCODING_LABEL[file.encoding] || file.encoding}</span>
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

      {file.readOnly ? (
        <p className="editor-notice">
          {file.relPath ? '该文件为只读（二进制、过大或无法解码）' : ''}
        </p>
      ) : null}

      {hadConflict && conflictCount === 0 && !unrecognizedConflict && file.dirty ? (
        <p className="editor-notice editor-notice-done">
          冲突已全部处理。按 Ctrl+S 保存，然后点「暂存」标记为已解决。
        </p>
      ) : null}

      {hadConflict && conflictCount === 0 && !unrecognizedConflict && !file.dirty && !file.readOnly && file.relPath ? (
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
          <FileTree group={group} activePath={file.relPath} onOpen={requestOpen} onError={onError} />
        )}
        <div className="editor-main">
          {file.relPath ? (
            <CodeMirrorHost
              value={file.content}
              filePath={file.relPath}
              readOnly={file.readOnly}
              themeMode={themeMode}
              onChange={update}
              onConflictCountChange={setConflictCount}
            />
          ) : (
            <p className="editor-placeholder">从左侧选择文件</p>
          )}
        </div>
      </div>

      {pendingPath ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card editor-confirm">
            <p className="confirm-message">
              「{file.relPath}」有未保存的修改，切换将丢失。是否继续？
            </p>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setPendingPath(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const next = pendingPath;
                  setPendingPath(null);
                  if (next) void open(next);
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
