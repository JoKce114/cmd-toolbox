import { useCallback, useEffect, useRef, useState } from 'react';
import { Save, Search, X } from 'lucide-react';
import { cn, toErrorMessage } from '../lib';
import { useEditorFiles } from '../useEditorFiles';
import { FileTree } from './FileTree';
import { EditorSidebar } from './EditorSidebar';
import { OpenEditors } from './OpenEditors';
import { ConfirmDialog } from './ConfirmDialog';
import { SearchPanel } from './SearchPanel';
import { CodeMirrorHost } from './CodeMirrorHost';
import { findModule } from '../modules/catalog';
import type { EditorModule } from '../modules/catalog';
import { enqueueMinify, isMinifiable, minifiedName, nextMinifySeq } from '../modules/minify';
import type { FileClip } from '../fileClipboard';
import type { Group, SymbolMatch, Tab } from '../types';
import type { TerminalThemeMode } from '../theme';
import type { KeyBindingMap } from '../editorKeymap';
import type { EditorFontFamily } from '../prefs';
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
  fontSize: number;
  lineHeight: number;
  fontFamily: EditorFontFamily;
  showLineNumbers: boolean;
  highlightActiveLine: boolean;
  bracketMatching: boolean;
  showWhitespace: boolean;
  enabledModules: string[];
  onFontSizeDelta: (delta: number) => void;
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
  fontSize,
  lineHeight,
  fontFamily,
  showLineNumbers,
  highlightActiveLine,
  bracketMatching,
  showWhitespace,
  enabledModules,
  onFontSizeDelta,
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
    closeMany,
    rename,
    setActivePath,
  } = useEditorFiles(group, onError);

  const [fileClip, setFileClip] = useState<FileClip | null>(null);
  // 确认框弹出前就把受影响的页签和 dirty 状态定格：
  // 弹窗期间用户无法编辑，但删除目录时 files[relPath] 恒为 undefined，
  // 必须提前收集其下未保存的页签，否则会静默丢内容。
  const [pendingDelete, setPendingDelete] = useState<{
    relPath: string;
    dirtyPaths: string[];
  } | null>(null);
  const [conflictCount, setConflictCount] = useState(0);
  const [hadConflict, setHadConflict] = useState(false);
  const [markingResolved, setMarkingResolved] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const [gotoLine, setGotoLine] = useState<number | null>(null);
  // 跨文件跳转时 activePath 先切换、文件内容后到达。这里先记下目标行，
  // 等内容真正加载完再交给 CodeMirrorHost，否则会被 clamp 到空文档的第 1 行。
  const pendingGotoRef = useRef<{ relPath: string; line: number } | null>(null);

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
    const outcome = await save(target);
    // 没改动时也要给反馈：否则按了 Ctrl+S 却什么都不发生，会让人以为保存失灵。
    // 失败路径由 useEditorFiles 内部的 onError 提示，这里不重复。
    if (outcome === 'saved') onToast('已保存', 'success');
    else if (outcome === 'unchanged') onToast('文件没有改动', 'info');
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

  // 目标文件内容就绪后再定位：open() 是异步的，先把 loading 状态的空文档挂上去，
  // 此时设置 gotoLine 会被 CodeMirrorHost clamp 到第 1 行并提前复位。
  useEffect(() => {
    const pending = pendingGotoRef.current;
    if (!pending) return;
    const target = files[pending.relPath];
    if (pending.relPath !== activePath) {
      // 用户中途切走或加载失败：放弃这次待定位，避免以后重新打开该文件时误跳
      if (!target || !target.loading) pendingGotoRef.current = null;
      return;
    }
    if (!target || target.loading) return;
    pendingGotoRef.current = null;
    setGotoLine(pending.line);
  }, [activePath, files]);

  const jumpToSymbol = useCallback(
    (match: SymbolMatch) => {
      if (match.relPath === activePathRef.current) {
        pendingGotoRef.current = null;
        setGotoLine(match.line);
        return;
      }
      pendingGotoRef.current = { relPath: match.relPath, line: match.line };
      void open(match.relPath).then((opened) => {
        if (opened) return;
        // 打开失败时 files 里不会有这个条目，effect 等不到 loading 变 false；
        // 在这里清掉 pending，避免用户以后手动打开该文件时被莫名跳到这一行。
        if (pendingGotoRef.current?.relPath === match.relPath) {
          pendingGotoRef.current = null;
        }
      });
    },
    [open],
  );

  // 文件树的「生成 xxx.min.js」：读磁盘上的源文件、压缩、写出产物。
  // 用磁盘内容而不是编辑器内容——从文件树压缩的文件可能根本没打开过。
  const canMinify = (relPath: string) => isMinifiable(relPath);

  const runMinify = useCallback(
    async (relPath: string) => {
      const projectPath = group.path;
      const output = minifiedName(relPath);
      // 序号必须在任何 await 之前取：与自动压缩共用「后发起者优先」判定。
      // 漏传会落到 0，被本会话任意一次自动压缩永久压住，点了没有任何效果。
      const seq = nextMinifySeq();
      try {
        const source = await window.api.files.read(projectPath, relPath);
        const outcome = await enqueueMinify(
          projectPath,
          output,
          source.content,
          async (compressed) => {
            await window.api.files.writeMinified(projectPath, output, compressed);
          },
          seq,
        );
        // 被更新的任务取代时并没有写盘：不能报成功，也不能打开旧产物
        if (outcome !== 'written') {
          onToast('已有更新的压缩任务，本次未写入', 'error');
          return;
        }
        onToast(`已生成 ${output.split('/').pop()}`, 'success');
        void open(output);
      } catch (error) {
        onToast(toErrorMessage(error), 'error');
      }
    },
    [group.path, onToast, open],
  );

  // 文件树完成重命名 / 剪切移动后，页签必须跟着换到新路径，
  // 否则继续编辑再保存会报 ENOENT。目录被移动时其下已打开的页签也要一起跟随。
  // 目标页签已存在且源页签 dirty 时 rename 会保留源页签、报告路径同步未完成，
  // 这里提示用户手动处理，不能默默把未保存内容关掉。
  const handleAfterRename = useCallback(
    (fromRel: string, toRel: string) => {
      let unsynced = false;
      if (files[fromRel]) {
        unsynced = !rename(fromRel, toRel).synced;
      } else {
        for (const relPath of Object.keys(files)) {
          if (relPath.startsWith(`${fromRel}/`)) {
            if (!rename(relPath, `${toRel}${relPath.slice(fromRel.length)}`).synced) {
              unsynced = true;
            }
          }
        }
      }
      if (unsynced) {
        onToast('目标文件已打开，旧页签的未保存修改已保留，请手动处理', 'error');
      }
    },
    [files, onToast, rename],
  );

  // 点删除时就确定这次操作会波及哪些已打开页签，以及其中哪些有未保存修改。
  // 目录的 dirty 状态不能只看 files[目录路径]——那个键根本不存在。
  const requestDelete = useCallback(
    (relPath: string) => {
      const affected = openPaths.filter(
        (openPath) => openPath === relPath || openPath.startsWith(`${relPath}/`),
      );
      const dirtyPaths = affected.filter((openPath) => files[openPath]?.dirty);
      setPendingDelete({ relPath, dirtyPaths });
    },
    [openPaths, files],
  );

  const confirmDelete = useCallback(async () => {
    const pending = pendingDelete;
    if (!pending) return;
    const { relPath } = pending;
    setPendingDelete(null);
    const doomed = openPaths.filter(
      (openPath) => openPath === relPath || openPath.startsWith(`${relPath}/`),
    );
    try {
      await window.api.files.trash(group.path, relPath);
      // 必须等真正删掉之后再关页签：trash 失败时用户既没删成文件、又丢了页签。
      if (doomed.length > 0) closeMany(doomed);
      onToast(`已删除 ${relPath}`, 'success');
    } catch (error) {
      onToast(toErrorMessage(error), 'error');
    }
  }, [pendingDelete, openPaths, closeMany, group.path, onToast]);

  // 删除确认文案：目录里有未保存文件时必须点名数量，否则用户会以为只是删个空目录。
  const deleteConfirmMessage = (pending: { relPath: string; dirtyPaths: string[] }) => {
    const { relPath, dirtyPaths } = pending;
    if (dirtyPaths.length === 0) return `确定把「${relPath}」删除到回收站吗？`;
    const isDirectory = dirtyPaths.some((item) => item.startsWith(`${relPath}/`));
    if (isDirectory) {
      return `「${relPath}」目录下有 ${dirtyPaths.length} 个未保存的文件，删除后不可恢复。确定删除到回收站吗？`;
    }
    return `「${relPath}」有未保存的修改，删除后不可恢复。确定删除到回收站吗？`;
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

  // 诊断模块按当前文件扩展名与开关状态挑一个。
  // findModule 返回清单里的同一对象，引用稳定，可以安全作为 effect 依赖；
  // 这样父组件每次渲染产生新的 enabledModules 数组也不会反复重配 linter。
  const lang = activePath.split('.').pop()?.toLowerCase() || '';
  const diagnosticModule: EditorModule | null =
    lang === 'php'
      ? enabledModules.includes('diag-php')
        ? findModule('diag-php') ?? null
        : null
      : ['js', 'mjs', 'cjs', 'jsx'].includes(lang) && enabledModules.includes('diag-js')
        ? findModule('diag-js') ?? null
        : null;

  // 符号跳转模块的判定与上面的诊断模块保持一致：同样按 lang 和开关状态挑。
  const referenceModule: EditorModule | null =
    lang === 'php'
      ? enabledModules.includes('ref-php')
        ? findModule('ref-php') ?? null
        : null
      : ['js', 'mjs', 'cjs', 'jsx'].includes(lang) && enabledModules.includes('ref-js')
        ? findModule('ref-js') ?? null
        : null;

  // 打开编辑器时预热符号索引：全量扫描要几百毫秒到一两秒，
  // 放在用户第一次 Ctrl+点击之前做完，点击就不会卡。
  useEffect(() => {
    const bridge = window.api?.symbols;
    if (!bridge?.warm) return;
    void bridge.warm(group.path).catch(() => {});
  }, [group.path]);

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
        <EditorSidebar
          openEditors={
            <OpenEditors
              openPaths={openPaths}
              activePath={activePath}
              onSelect={(relPath) => setActivePath(relPath)}
            />
          }
          fileTree={
            searchOpen ? (
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
              <FileTree
                group={group}
                activePath={activePath}
                onOpen={requestOpen}
                onMinify={runMinify}
                canMinify={canMinify}
                onError={onError}
                onToast={onToast}
                clip={fileClip}
                onClipChange={setFileClip}
                onRequestDelete={requestDelete}
                onAfterRename={handleAfterRename}
              />
            )
          }
        />
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
              fontSize={fontSize}
              lineHeight={lineHeight}
              fontFamily={fontFamily}
              showLineNumbers={showLineNumbers}
              highlightActiveLine={highlightActiveLine}
              bracketMatching={bracketMatching}
              showWhitespace={showWhitespace}
              diagnosticModule={diagnosticModule}
              referenceEnabled={Boolean(referenceModule)}
              projectPath={group.path}
              onJumpToSymbol={jumpToSymbol}
              gotoLine={gotoLine}
              onGotoLineApplied={() => setGotoLine(null)}
              onFontSizeDelta={onFontSizeDelta}
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

      {pendingDelete ? (
        <ConfirmDialog
          title="删除到回收站"
          message={deleteConfirmMessage(pendingDelete)}
          confirmLabel="删除"
          onClose={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      ) : null}
    </section>
  );
}
