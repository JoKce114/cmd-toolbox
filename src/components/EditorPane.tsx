import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronsDownUp, FilePlus, FolderPlus, Plus, RefreshCw, Save, Search, X } from 'lucide-react';
import { cn, toErrorMessage } from '../lib';
import { buildTextPatch } from '../diffFromText';
import { useEditorFiles } from '../useEditorFiles';
import type { EditorFileState } from '../useEditorFiles';
import {
  displayNameFor,
  isUntitledPath,
  nextUntitledIndex,
  UNTITLED_PREFIX,
  untitledPathFor,
} from '../untitledPath';
import { SaveAsModal } from './SaveAsModal';
import { FileTree } from './FileTree';
import type { FileTreeHandle } from './FileTree';
import { EditorSidebar } from './EditorSidebar';
import { OpenEditors } from './OpenEditors';
import { ConfirmDialog } from './ConfirmDialog';
import { SearchPanel } from './SearchPanel';
import { CodeMirrorHost } from './CodeMirrorHost';
import { EditorOverviewRuler } from './EditorOverviewRuler';
import { computeLineChanges } from '../lineChanges';
import type { LineChanges } from '../lineChanges';
import { DiffPane } from './DiffPane';
import type { DiffTarget } from './DiffPane';
import { PopupMenu } from './PopupMenu';
import { findModule } from '../modules/catalog';
import type { EditorModule } from '../modules/catalog';
import { enqueueMinify, isMinifiable, minifiedName, nextMinifySeq } from '../modules/minify';
import type { FileClip } from '../fileClipboard';
import type { Group, GitStatus, MenuState, SymbolMatch, Tab } from '../types';
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

// 会话恢复出来但内容为空的窗口没有可丢失的内容，关闭时不必弹确认；
// 用户编辑过（dirty）仍按未保存修改处理，不能绕过确认。
function losesSessionContent(entry: EditorFileState | undefined): boolean {
  if (!entry?.sessionOnly) return false;
  return entry.content !== '';
}

// 对比的「另一端」是什么。存原始基准文本而不是算好的 patch，
// 这样编辑器内容变化时可以实时重算，不必重新读磁盘 / git。
type DiffSource =
  | { kind: 'disk'; relPath: string; baseText: string }
  | { kind: 'pair'; left: string; right: string }
  | { kind: 'head'; relPath: string; baseText: string };

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
  // 页签对应的文件路径变化（空白窗口新建 / 另存为后换真实路径）
  onFilePathChange?: (relPath: string) => void;
  // 空白窗口内容快照（键是虚拟路径）：内容只能跟着会话走，没有磁盘副本
  onUntitledContentsChange?: (contents: Record<string, string>) => void;
  // 会话恢复时带下来的空白窗口内容（同样以虚拟路径为键）
  untitledRestore?: Record<string, string>;
  // 会话里因超限被丢弃的空白窗口：恢复成空窗口并提示，但编号要保留
  untitledDropped?: string[];
  // Git 变更条目的指纹，变化时重新拉 HEAD 基准
  gitStateKey?: string;
  // 本项目是否为 Git 仓库。undefined 表示状态未知（仍在加载、或不是当前激活项目），
  // 此时不出标记：非仓库里 fileDiff 会把文件当未跟踪、返回空基准，整篇会被误判成新增。
  gitRepo?: boolean;
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
  onFilePathChange,
  onUntitledContentsChange,
  untitledRestore,
  untitledDropped,
  gitStateKey,
  gitRepo,
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
    saveUntitledAs,
    restoreUntitled,
  } = useEditorFiles(group, onError);

  const [fileClip, setFileClip] = useState<FileClip | null>(null);
  // 文件树的刷新信号：删除成功后自增，让 FileTree 重新列目录。
  // 页签关闭由本组件负责，但树的行只有 FileTree 自己知道怎么刷新。
  const [treeRefreshToken, setTreeRefreshToken] = useState(0);
  // 工具栏按钮挂在「文件」分区标题行上，动作仍由 FileTree 自己实现
  const fileTreeRef = useRef<FileTreeHandle>(null);
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

  const [diffSource, setDiffSource] = useState<DiffSource | null>(null);
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);
  // 「选择以进行比较」暂存的左侧文件；为空时菜单项退化为「选择以进行比较」
  const [diffCompareWith, setDiffCompareWith] = useState<string | null>(null);
  const [diffRatio, setDiffRatio] = useState(0.5);
  const diffDragRef = useRef<{ x: number; ratio: number; width: number } | null>(null);
  const [diffDragging, setDiffDragging] = useState(false);
  // 右键时才查一次 git 状态，只用于把「与 Git HEAD 比较」在未跟踪文件上置灰
  const [editorGitStatus, setEditorGitStatus] = useState<GitStatus | null>(null);
  const menuStatusSeqRef = useRef(0);
  // HEAD 基准按文件缓存，避免每次按键都读一次 git；窗口重新获得焦点或
  // Git 状态变化（提交 / 暂存 / 切分支）时整体丢弃。
  // 失败（非 Git 项目等）也缓存：text 为 null，避免每次停顿都重发 IPC、起 git 进程。
  const [changeMarkers, setChangeMarkers] = useState<LineChanges | null>(null);
  const baseTextRef = useRef(new Map<string, { text: string | null; at: number }>());
  const [baseRefreshToken, setBaseRefreshToken] = useState(0);
  const [editorMenu, setEditorMenu] = useState<{
    x: number;
    y: number;
    relPath: string;
  } | null>(null);
  // 空白窗口按 Ctrl+S 时打开另存为弹窗，值是被保存的虚拟路径
  const [saveAsPath, setSaveAsPath] = useState<string | null>(null);
  const [tabMenu, setTabMenu] = useState<MenuState | null>(null);

  const closeDiff = useCallback(() => {
    setDiffSource(null);
    setDiffTarget(null);
  }, []);

  // 只读 / 二进制 / 超大文件的内容是空串，拿它做对比只会得到「全部删除」
  // 或「两处内容一致」这类假结果，比报错更误导。菜单置灰之外，这里再兜底一次：
  // 菜单不是唯一入口，将来也可能有别的调用路径。
  const rejectReadOnlyCompare = useCallback(
    (entries: Array<EditorFileState | undefined>): boolean => {
      if (!entries.some((entry) => entry?.readOnly)) return false;
      onToast('该文件为只读或二进制，无法对比', 'error');
      return true;
    },
    [onToast],
  );

  // 与磁盘版本比较：左旧（磁盘）右新（内存）。参数顺序不能反。
  const compareWithDisk = useCallback(
    async (relPath: string) => {
      if (isUntitledPath(relPath)) {
        onToast('空白窗口没有可比较的版本', 'error');
        return;
      }
      const entry = files[relPath];
      if (!entry) return;
      if (rejectReadOnlyCompare([entry])) return;
      try {
        const disk = await window.api.files.read(group.path, relPath);
        setActivePath(relPath);
        setDiffSource({ kind: 'disk', relPath, baseText: disk.content });
        setDiffTarget({
          kind: 'text',
          title: `${relPath} ↔ 磁盘版本`,
          patch: buildTextPatch('磁盘版本', disk.content, '当前编辑', entry.content),
        });
        setDiffCompareWith(null);
      } catch (error) {
        onToast(toErrorMessage(error), 'error');
      }
    },
    [files, group.path, onToast, rejectReadOnlyCompare, setActivePath],
  );

  // 两个已打开文件互比
  const compareTwoFiles = useCallback(
    (leftRel: string, rightRel: string) => {
      const left = files[leftRel];
      const right = files[rightRel];
      if (!left || !right) return;
      if (rejectReadOnlyCompare([left, right])) return;
      // 编辑器始终显示其中一侧，否则切换文件后的自动关闭会立刻触发
      if (activePath !== leftRel && activePath !== rightRel) setActivePath(leftRel);
      setDiffSource({ kind: 'pair', left: leftRel, right: rightRel });
      setDiffTarget({
        kind: 'text',
        title: `${displayNameFor(leftRel)} ↔ ${displayNameFor(rightRel)}`,
        patch: buildTextPatch(
          displayNameFor(leftRel),
          left.content,
          displayNameFor(rightRel),
          right.content,
        ),
      });
      setDiffCompareWith(null);
    },
    [files, activePath, rejectReadOnlyCompare, setActivePath],
  );

  // 与 Git HEAD 比较：git 后端给出基准文本，patch 由渲染侧生成以便随编辑实时重算
  const compareWithHead = useCallback(
    async (relPath: string) => {
      if (isUntitledPath(relPath)) {
        onToast('空白窗口没有可比较的版本', 'error');
        return;
      }
      const entry = files[relPath];
      if (!entry) return;
      if (rejectReadOnlyCompare([entry])) return;
      try {
        const result = await window.api.git.fileDiff(group.path, relPath, 'modified', 'HEAD');
        const baseText = result.baseContent ?? '';
        setActivePath(relPath);
        setDiffSource({ kind: 'head', relPath, baseText });
        setDiffTarget({
          kind: 'text',
          title: `${relPath} ↔ Git HEAD`,
          patch: buildTextPatch('Git HEAD', baseText, '当前编辑', entry.content),
        });
        setDiffCompareWith(null);
      } catch (error) {
        onToast(toErrorMessage(error), 'error');
      }
    },
    [files, group.path, onToast, rejectReadOnlyCompare, setActivePath],
  );

  const openOpenEditorMenu = useCallback(
    (event: React.MouseEvent, relPath: string) => {
      event.preventDefault();
      setEditorMenu({
        x: event.clientX,
        y: event.clientY,
        relPath,
      });
      setEditorGitStatus(null);
      const seq = menuStatusSeqRef.current + 1;
      menuStatusSeqRef.current = seq;
      void window.api.git
        .status(group.path)
        .then((next) => {
          if (seq === menuStatusSeqRef.current) setEditorGitStatus(next);
        })
        .catch(() => {
          if (seq === menuStatusSeqRef.current) setEditorGitStatus(null);
        });
    },
    [group.path],
  );

  const loadHeadBase = useCallback(
    async (relPath: string): Promise<string | null> => {
      // 非 Git 项目不能取 HEAD 基准：fileDiff 在非仓库里不会 reject，
      // 而是把每个文件都当成未跟踪并返回空串，直接算下去会整篇显示成新增。
      // undefined 表示状态未知，同样先不出标记，等 App 拿到 git status 再算。
      if (gitRepo !== true) return null;
      const cached = baseTextRef.current.get(relPath);
      if (cached && Date.now() - cached.at < 60_000) return cached.text;
      try {
        const result = await window.api.git.fileDiff(group.path, relPath, 'modified', 'HEAD');
        const text = result.baseContent ?? '';
        baseTextRef.current.set(relPath, { text, at: Date.now() });
        return text;
      } catch {
        // 非 Git 项目 / git 不可用：静默不显示标记。
        // 失败也要缓存，否则每次停顿都会重发一次 IPC 并起两个 git 进程。
        baseTextRef.current.set(relPath, { text: null, at: Date.now() });
        return null;
      }
    },
    [group.path, gitRepo],
  );

  // 窗口重新获得焦点时丢掉缓存：提交完切回来，标记应当自动消失
  useEffect(() => {
    const onFocus = () => {
      baseTextRef.current.clear();
      setBaseRefreshToken((value) => value + 1);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // Git 状态条目变化（提交 / 暂存 / 放弃 / 切分支）同样让缓存失效
  useEffect(() => {
    baseTextRef.current.clear();
    setBaseRefreshToken((value) => value + 1);
  }, [gitStateKey]);

  useEffect(() => {
    if (!activePath || isUntitledPath(activePath) || file.readOnly) {
      setChangeMarkers(null);
      return;
    }
    // 非仓库 / 仓库状态未知时立即清空，不必等 300ms 防抖再走一次死路。
    if (gitRepo !== true) {
      setChangeMarkers(null);
      return;
    }
    const relPath = activePath;
    const content = file.content;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadHeadBase(relPath).then((base) => {
        if (cancelled) return;
        setChangeMarkers(base === null ? null : computeLineChanges(base, content));
      });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activePath, file, loadHeadBase, gitRepo, baseRefreshToken]);

  // 实时重算只依赖原始字符串：object/state 作为依赖会在每次渲染时换身份，
  // 既容易触发多余计算，也容易写出无限循环。
  const diffPrimaryPath = diffSource?.kind === 'pair' ? diffSource.left : diffSource?.relPath ?? '';
  const diffSecondaryPath = diffSource?.kind === 'pair' ? diffSource.right : '';
  const diffPrimaryContent = diffPrimaryPath ? files[diffPrimaryPath]?.content : undefined;
  const diffSecondaryContent = diffSecondaryPath ? files[diffSecondaryPath]?.content : undefined;

  // 对比打开期间编辑器仍可编辑，patch 必须跟着内存内容走（300ms 防抖）。
  useEffect(() => {
    if (!diffSource) return;
    const timer = window.setTimeout(() => {
      let patch = '';
      if (diffSource.kind === 'pair') {
        patch = buildTextPatch(
          displayNameFor(diffSource.left),
          diffPrimaryContent ?? '',
          displayNameFor(diffSource.right),
          diffSecondaryContent ?? '',
        );
      } else if (diffSource.kind === 'disk') {
        patch = buildTextPatch(
          '磁盘版本',
          diffSource.baseText,
          '当前编辑',
          diffPrimaryContent ?? '',
        );
      } else {
        patch = buildTextPatch(
          'Git HEAD',
          diffSource.baseText,
          '当前编辑',
          diffPrimaryContent ?? '',
        );
      }
      setDiffTarget((previous) =>
        previous && previous.kind === 'text' && previous.patch !== patch
          ? { ...previous, patch }
          : previous,
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [diffSource, diffPrimaryContent, diffSecondaryContent]);

  // 切到对比之外的文件、或对比涉及的文件被关掉时，自动回到单编辑器。
  // 显示另一边已经过期的 diff 比直接关掉更危险。
  useEffect(() => {
    if (!diffSource) return;
    const paths =
      diffSource.kind === 'pair' ? [diffSource.left, diffSource.right] : [diffSource.relPath];
    if (paths.some((relPath) => !files[relPath])) {
      closeDiff();
      return;
    }
    if (!activePath || !paths.includes(activePath)) closeDiff();
  }, [activePath, diffSource, files, closeDiff]);

  // 「与 xxx 比较」指向的文件被关闭后，菜单项必须退回「选择以进行比较」
  useEffect(() => {
    if (diffCompareWith && !files[diffCompareWith]) setDiffCompareWith(null);
  }, [diffCompareWith, files]);

  const handleDiffPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const root = event.currentTarget.parentElement;
      if (!root) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDiffDragging(true);
      diffDragRef.current = {
        x: event.clientX,
        ratio: diffRatio,
        width: Math.max(root.getBoundingClientRect().width, 80),
      };
    },
    [diffRatio],
  );

  const handleDiffPointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const state = diffDragRef.current;
    if (!state) return;
    const delta = (event.clientX - state.x) / state.width;
    setDiffRatio(Math.min(0.85, Math.max(0.15, state.ratio + delta)));
  }, []);

  const handleDiffPointerUp = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    diffDragRef.current = null;
    setDiffDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const rootRef = useRef<HTMLElement>(null);
  const fileRef = useRef(file);
  fileRef.current = file;
  // Ctrl+W 的 keydown effect 只在挂载时注册一次，闭包里的 files 会过期。
  // 关页签前要读最新的状态（dirty / sessionOnly），所以走 ref。
  const filesRef = useRef(files);
  filesRef.current = files;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  // 回调每次渲染都是新函数：放进 ref，避免 effect 因函数身份变化而反复触发
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const onFilePathChangeRef = useRef(onFilePathChange);
  onFilePathChangeRef.current = onFilePathChange;
  const onUntitledContentsChangeRef = useRef(onUntitledContentsChange);
  onUntitledContentsChangeRef.current = onUntitledContentsChange;
  // 只取挂载时的首值：恢复只在挂载早期做一次，之后父组件传什么都不该再灌一遍
  const untitledRestoreRef = useRef(untitledRestore);
  const untitledDroppedRef = useRef(untitledDropped);
  const restoredRef = useRef(false);
  // 首次挂载时恢复是 layout effect 写入的，紧随其后的被动 effect 仍可能读到
  // 旧的空 files。只有「确实出现过内容」之后才允许清理 filePath，否则会把
  // 刚恢复的绑定清成空串，下次启动这个窗口就不会被激活。
  const hadContentRef = useRef(false);

  // 页签的 filePath 会变（上层用同一个编辑器页签顶替新文件），
  // 所以要比对「上次已应用的路径」而不是只在挂载时读一次。
  const appliedPathRef = useRef('');

  // 会话恢复必须在首次 open(tab.filePath) 之前完成：open() 对空白窗口会补一个
  // 空条目，晚一步就会把恢复的内容覆盖成空串。用 useLayoutEffect 让 setFiles
  // 在被动 effect（同步 filePath 的那个）之前提交，open() 就能看到已恢复的条目。
  useLayoutEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const saved = untitledRestoreRef.current || {};
    const entries = Object.entries(saved).filter(
      ([relPath, content]) => isUntitledPath(relPath) && typeof content === 'string',
    );
    // 超限被丢弃的窗口只剩下编号。必须按空窗口恢复，并且把这些编号保留下来：
    // 否则恢复的内容会被重排到该编号上，上层 filePath 再打开同一个编号时
    // 用户看到的就是另一个窗口的内容。
    const dropped = Array.from(
      new Set((untitledDroppedRef.current || []).filter((relPath) => isUntitledPath(relPath))),
    ).filter((relPath) => !Object.prototype.hasOwnProperty.call(saved, relPath));
    if (!entries.length && !dropped.length) return;

    const reserved = new Set(
      dropped.map((relPath) => Number(relPath.slice(UNTITLED_PREFIX.length))),
    );
    // 编号按最小可用值重新分配：会话里可能只剩 untitled://3，
    // 恢复成 Untitled-1 才符合「关掉的编号会被复用」的直觉。
    // 分配时跳过被丢弃条目的编号，避免和它们的空窗口撞号。
    const ordered = entries.slice().sort(
      ([left], [right]) =>
        Number(left.slice(UNTITLED_PREFIX.length)) -
        Number(right.slice(UNTITLED_PREFIX.length)),
    );
    const remapped = new Map<string, string>();
    let cursor = 1;
    for (const [oldPath] of ordered) {
      while (reserved.has(cursor)) cursor += 1;
      remapped.set(oldPath, untitledPathFor(cursor));
      cursor += 1;
    }
    restoreUntitled([
      ...ordered.map(([oldPath, content]) => ({
        relPath: remapped.get(oldPath) as string,
        content,
      })),
      // 被丢弃的窗口没有内容可保护，恢复成普通空窗口即可，不必弹关闭确认
      ...dropped.map((relPath) => ({ relPath, content: '', sessionOnly: false })),
    ]);

    if (dropped.length) {
      const names = dropped.map((relPath) => `「${displayNameFor(relPath)}」`).join('');
      onToast(`${names}的内容超过会话存储上限，未能恢复`, 'error');
    }

    const currentPath = tab.filePath || '';
    if (isUntitledPath(currentPath)) {
      const mapped =
        remapped.get(currentPath) || (dropped.includes(currentPath) ? currentPath : '');
      if (mapped) {
        // 上层稍后会写回新编号，这里先把旧路径记成「已应用」，
        // 免得同步 filePath 的 effect 用旧编号再 open 一次空条目。
        appliedPathRef.current = currentPath;
        onFilePathChangeRef.current?.(mapped);
        setActivePath(mapped);
      }
    } else if (!currentPath) {
      const first = remapped.get(ordered[0]?.[0] ?? '');
      if (first) setActivePath(first);
    }
  }, [restoreUntitled, setActivePath, tab.filePath, onToast]);

  useEffect(() => {
    const next = tab.filePath || '';
    if (!next || next === appliedPathRef.current) return;
    appliedPathRef.current = next;
    void open(next);
  }, [tab.filePath, open]);

  // 会话记录的路径已经不在编辑器里（空白窗口被关掉）时要同步给上层。
  // 否则会话里仍留着旧虚拟路径，下次启动会照着它重新开出一个空窗口。
  // 只处理虚拟路径：普通文件的 filePath 同步是既有行为，不在本次改动范围。
  useEffect(() => {
    // 首次挂载时 files 可能还是空的（见 hadContentRef 的声明）。
    // 此时不能把恢复的 filePath 清掉；先记录「曾经有过内容」再放开清理。
    if (!hadContentRef.current) {
      if (Object.keys(files).length > 0) hadContentRef.current = true;
      return;
    }
    const current = tab.filePath || '';
    if (!isUntitledPath(current) || files[current]) return;
    const next = activePath && files[activePath] ? activePath : '';
    if (next === current) return;
    appliedPathRef.current = next;
    onFilePathChangeRef.current?.(next);
  }, [activePath, files, tab.filePath]);

  // 编辑器内切换文件时要回写上层：运行时会话恢复靠它，
  // App 侧「已打开的文件」去重与未保存拦截也依赖 tab.filePath 是最新的。
  useEffect(() => {
    if (!activePath || !files[activePath] || isUntitledPath(activePath)) return;
    if (activePath === tab.filePath) return;
    // 必须先更新 appliedPathRef 再回调，否则上层 filePath 变化会让
    // 上面那个 effect 重新 open()，撤销栈和光标全丢。
    appliedPathRef.current = activePath;
    onFilePathChangeRef.current?.(activePath);
  }, [activePath, files, tab.filePath]);

  // 空白窗口内容快照：只比较各空白条目的内容引用并维护版本号，不把全部内容
  // 拼成一个字符串（2MB 上限下那会是每键 O(总内容)）。普通文件每次按键都会换
  // files 对象，这里最多做 O(空白窗口数) 的引用比较。快照用来触发
  // onUntitledContentsChange，必须识别「长度相同但内容不同」，所以按内容引用
  // 变化递增版本，而不是只比长度。
  const untitledContentCacheRef = useRef(new Map<string, string>());
  const untitledVersionRef = useRef(new Map<string, number>());
  const untitledSnapshot = useMemo(() => {
    const cache = untitledContentCacheRef.current;
    const versions = untitledVersionRef.current;
    const parts: string[] = [];
    const seen = new Set<string>();
    for (const relPath of openPaths) {
      if (!isUntitledPath(relPath)) continue;
      seen.add(relPath);
      const content = files[relPath]?.content ?? '';
      let version = versions.get(relPath) ?? 0;
      if (cache.get(relPath) !== content) {
        version += 1;
        versions.set(relPath, version);
        cache.set(relPath, content);
      }
      parts.push(`${relPath}\u0000${version}`);
    }
    // 关掉的条目不能留下缓存：同编号重新打开时要重新计数，
    // 否则旧版本号会和新内容撞在一起。
    for (const relPath of Array.from(cache.keys())) {
      if (seen.has(relPath)) continue;
      cache.delete(relPath);
      versions.delete(relPath);
    }
    return parts.join('\u0001');
  }, [openPaths, files]);

  useEffect(() => {
    const contents: Record<string, string> = {};
    for (const relPath of Object.keys(files)) {
      if (!isUntitledPath(relPath)) continue;
      contents[relPath] = files[relPath].content;
    }
    onUntitledContentsChangeRef.current?.(contents);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [untitledSnapshot]);

  const hasSessionOnly = openPaths.some((relPath) => losesSessionContent(files[relPath]));

  useEffect(() => {
    const base = activePath ? displayNameFor(activePath) : '编辑器';
    onTitleChangeRef.current(`${group.name} · ${base}${hasDirty ? ' •' : ''}`);
  }, [activePath, hasDirty, group.name]);

  useEffect(() => {
    // sessionOnly 不算「未保存」（标题不显示 •），但关掉整个编辑器页签时
    // 同样会永久丢内容，所以要把 App 的 dirty 守卫一起点亮。
    onDirtyChangeRef.current(tab.id, hasDirty || hasSessionOnly);
  }, [tab.id, hasDirty, hasSessionOnly]);

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
    // 空白窗口没有磁盘路径，保存 = 另存为
    if (isUntitledPath(target)) {
      setSaveAsPath(target);
      return;
    }
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

  // 页签栏的 ＋ 与右键菜单共用：算最小可用编号，建空白窗口并把页签路径同步给上层。
  // 直接调 open() 建条目；上层回写 filePath 后，appliedPathRef 已指向同一路径，
  // 挂载时同步路径的 effect 会提前返回，不会重复打开。
  const createUntitled = useCallback(() => {
    const relPath = untitledPathFor(nextUntitledIndex(openPaths));
    appliedPathRef.current = relPath;
    void open(relPath);
    onFilePathChangeRef.current?.(relPath);
  }, [openPaths, open]);

  const markResolved = useCallback(async () => {
    const target = activePathRef.current;
    if (!target) return;
    // 空白窗口没有磁盘文件，git stage 会拿 untitled://N 去执行并弹错误 toast。
    if (isUntitledPath(target)) return;
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
    const target = filesRef.current[relPath];
    // sessionOnly：内容只存在于会话里，关掉就永久丢失，必须确认。
    // 恢复出来但内容为空的窗口没有可丢的内容，不必打扰用户。
    if (target?.dirty || losesSessionContent(target)) {
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
      setTreeRefreshToken((token) => token + 1);
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

  // 单个页签的关闭确认文案：sessionOnly 的条目要点明「只存在于会话」，
  // 否则用户会把它当成普通空白窗口，确认框看起来像在问一个空文件。
  // 恢复后又编辑过时 dirty 与 sessionOnly 同时成立，两种后果都要说清楚。
  const closeConfirmMessage = (relPath: string) => {
    const name = displayNameFor(relPath);
    const entry = files[relPath];
    if (losesSessionContent(entry)) {
      if (entry?.dirty) {
        return `「${name}」有未保存的修改，且内容只存在于会话中，关闭后不可恢复。是否继续？`;
      }
      return `「${name}」的内容只存在于会话中，关闭后不可恢复。是否继续？`;
    }
    return `「${name}」有未保存的修改，关闭将丢失。是否继续？`;
  };

  const requestClose = () => {
    const blocking = openPaths.filter(
      (item) => files[item].dirty || losesSessionContent(files[item]),
    );
    if (blocking.length > 0) {
      const dirtyNames = blocking
        .filter((item) => files[item].dirty && !losesSessionContent(files[item]))
        .map((item) => `「${displayNameFor(item)}」`)
        .join('、');
      const bothNames = blocking
        .filter((item) => files[item].dirty && losesSessionContent(files[item]))
        .map((item) => `「${displayNameFor(item)}」`)
        .join('、');
      const sessionNames = blocking
        .filter((item) => !files[item].dirty && losesSessionContent(files[item]))
        .map((item) => `「${displayNameFor(item)}」`)
        .join('、');
      const reasons: string[] = [];
      if (dirtyNames) reasons.push(`${dirtyNames}有未保存的修改，关闭将丢失`);
      if (bothNames) {
        reasons.push(`${bothNames}有未保存的修改，且内容只存在于会话中，关闭后不可恢复`);
      }
      if (sessionNames) {
        reasons.push(`${sessionNames}的内容只存在于会话中，关闭后不可恢复`);
      }
      const ok = window.confirm(`${reasons.join('；')}。是否继续？`);
      if (!ok) return;
    }
    onClose(tab);
  };

  const encodingLabel = ENCODING_LABEL[file.encoding] || file.encoding;

  const menuFile = editorMenu ? files[editorMenu.relPath] : undefined;
  // git status 拿不到时保持可点：点击后由后端识别未跟踪并显示「全部新增」
  const menuUntracked = Boolean(
    editorMenu &&
      editorGitStatus?.ok &&
      editorGitStatus.changes.some(
        (change) => change.path === editorMenu.relPath && change.worktreeStatus === 'untracked',
      ),
  );

  // 只读 / 二进制 / 超大文件读出来是空串，三个对比入口全部置灰：
  // 对比只会给出假结果（设计稿要求「二进制文件对比入口置灰」）。
  const menuReadOnly = Boolean(menuFile?.readOnly);
  const menuUntitled = editorMenu ? isUntitledPath(editorMenu.relPath) : false;
  const pickedReadOnly = Boolean(diffCompareWith && files[diffCompareWith]?.readOnly);

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
          {activePath ? displayNameFor(activePath) : group.name}
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
          disabled={file.saving || file.readOnly}
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

      {/* 空面板也要保留页签栏：＋ 按钮是新建空白窗口的唯一入口 */}
      <div className="editor-tabs">
        {openPaths.map((relPath) => (
          <div
            key={relPath}
            className={cn('editor-tab', relPath === activePath && 'active')}
            onContextMenu={(event) => {
              event.preventDefault();
              setTabMenu({
                x: event.clientX,
                y: event.clientY,
                items: [
                  {
                    type: 'item',
                    id: 'new-untitled',
                    label: '新建空白文件',
                    onSelect: createUntitled,
                  },
                ],
              });
            }}
          >
            <button
              type="button"
              className="editor-tab-name"
              title={relPath}
              onClick={() => setActivePath(relPath)}
            >
              {displayNameFor(relPath)}
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
        <button
          type="button"
          className="editor-tab-add"
          title="新建空白文件"
          onClick={createUntitled}
        >
          <Plus size={12} />
        </button>
      </div>

      {file.readOnly && activePath ? (
        <p className="editor-notice">该文件为只读（二进制、过大或无法解码）</p>
      ) : null}

      {hadConflict && conflictCount === 0 && !unrecognizedConflict && file.dirty ? (
        <p className="editor-notice editor-notice-done">
          冲突已全部处理。按 Ctrl+S 保存，然后点「暂存」标记为已解决。
        </p>
      ) : null}

      {hadConflict && conflictCount === 0 && !unrecognizedConflict && !file.dirty && !file.readOnly && activePath && !isUntitledPath(activePath) ? (
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
          fileActions={
            <>
              <button
                type="button"
                className="icon-btn"
                title="新建文件夹"
                aria-label="新建文件夹"
                onClick={() => fileTreeRef.current?.createFolder()}
              >
                <FolderPlus size={13} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title="新建文件"
                aria-label="新建文件"
                onClick={() => fileTreeRef.current?.createFile()}
              >
                <FilePlus size={13} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title="刷新"
                aria-label="刷新"
                onClick={() => fileTreeRef.current?.reloadAll()}
              >
                <RefreshCw size={13} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title="全部折叠"
                aria-label="全部折叠"
                onClick={() => fileTreeRef.current?.collapseAll()}
              >
                <ChevronsDownUp size={13} />
              </button>
            </>
          }
          openEditors={
            <OpenEditors
              openPaths={openPaths}
              activePath={activePath}
              onSelect={(relPath) => setActivePath(relPath)}
              onContextMenu={(event, relPath) => openOpenEditorMenu(event, relPath)}
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
                ref={fileTreeRef}
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
                refreshToken={treeRefreshToken}
              />
            )
          }
        />
        <div className="editor-main">
          {activePath ? (
            // CodeMirrorHost 始终挂在同一位置：开关对比只改变父容器布局，
            // 不卸载编辑器，撤销栈、光标与滚动位置都保留。
            <div
              className={cn(
                'editor-diff-split',
                diffTarget && 'is-comparing',
                diffDragging && 'is-resizing',
              )}
            >
              <div
                className="editor-diff-pane"
                style={{ flex: diffTarget ? `${diffRatio} 1 0` : '1 1 0' }}
              >
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
                  changeMarkers={changeMarkers}
                  blameEnabled={
                    Boolean(activePath) && !file.readOnly && !isUntitledPath(activePath)
                  }
                  blameBlocked={Boolean(file.dirty)}
                />
                <EditorOverviewRuler changes={changeMarkers} />
              </div>
              {diffTarget ? (
                <>
                  <button
                    type="button"
                    className={`split-resizer${diffDragging ? ' is-dragging' : ''}`}
                    aria-label="调整对比宽度"
                    onPointerDown={handleDiffPointerDown}
                    onPointerMove={handleDiffPointerMove}
                    onPointerUp={handleDiffPointerUp}
                    onPointerCancel={handleDiffPointerUp}
                  />
                  <div className="editor-diff-pane" style={{ flex: `${1 - diffRatio} 1 0` }}>
                    <DiffPane
                      projectPath={group.path}
                      wordWrap={wordWrap}
                      target={diffTarget}
                      active
                      onClose={closeDiff}
                      onOpenFile={requestOpen}
                      onToast={onToast}
                    />
                  </div>
                </>
              ) : null}
            </div>
          ) : (
            <p className="editor-placeholder">从左侧选择文件</p>
          )}
        </div>
      </div>

      {pendingClose ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card editor-confirm">
            <p className="confirm-message">{closeConfirmMessage(pendingClose)}</p>
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

      {tabMenu ? <PopupMenu state={tabMenu} onClose={() => setTabMenu(null)} /> : null}

      {saveAsPath ? (
        <SaveAsModal
          suggestedName="untitled.txt"
          onClose={() => setSaveAsPath(null)}
          onSubmit={async (relPath) => {
            const result = await saveUntitledAs(saveAsPath, relPath);
            if (!result.ok) return result.message || '保存失败';
            // 先更新 appliedPathRef，避免上层 filePath 变化触发重新 open、
            // 把刚保存的内容从磁盘读一遍并清掉撤销栈
            appliedPathRef.current = relPath;
            onFilePathChangeRef.current?.(relPath);
            // 另存为会新建文件（还可能自动创建父目录）：文件树的 reveal 对
            // 根目录与已缓存目录都会提前返回，必须显式重列一次才看得到新文件。
            setTreeRefreshToken((token) => token + 1);
            onToast('已保存', 'success');
            return null;
          }}
        />
      ) : null}

      {editorMenu ? (
        <PopupMenu
          state={{
            x: editorMenu.x,
            y: editorMenu.y,
            items: [
              {
                type: 'item',
                id: 'diff-disk',
                label: '与已保存文件比较',
                disabled: menuReadOnly || menuUntitled || !menuFile?.dirty,
                onSelect: () => {
                  void compareWithDisk(editorMenu.relPath);
                  setEditorMenu(null);
                },
              },
              {
                type: 'item',
                id: 'diff-pick',
                label: diffCompareWith
                  ? `与 ${displayNameFor(diffCompareWith)} 比较`
                  : '选择以进行比较',
                disabled:
                  menuReadOnly || pickedReadOnly || diffCompareWith === editorMenu.relPath,
                onSelect: () => {
                  if (!diffCompareWith) {
                    setDiffCompareWith(editorMenu.relPath);
                  } else {
                    compareTwoFiles(diffCompareWith, editorMenu.relPath);
                  }
                  setEditorMenu(null);
                },
              },
              {
                type: 'item',
                id: 'diff-head',
                label: '与 Git HEAD 比较',
                disabled: menuReadOnly || menuUntitled || menuUntracked,
                onSelect: () => {
                  void compareWithHead(editorMenu.relPath);
                  setEditorMenu(null);
                },
              },
            ],
          }}
          onClose={() => setEditorMenu(null)}
        />
      ) : null}
    </section>
  );
}
