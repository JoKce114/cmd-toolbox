import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Copy, Eraser, FolderOpen, RotateCw, Search, SquareTerminal, X } from 'lucide-react';
import { formatDroppedPaths, shellShortLabel, toErrorMessage } from '../lib';
import { subscribeData } from '../ptyBus';
import { terminalThemes } from '../theme';
import type { TerminalThemeMode } from '../theme';
import type { Group, Tab } from '../types';
import type { ToastKind } from './Toast';

export type TerminalMenuActions = {
  hasSelection: () => boolean;
  copySelection: () => void;
  paste: () => void;
  selectAll: () => void;
  clear: () => void;
  hasLink: () => boolean;
  copyLink: () => void;
};

function droppedFilePaths(event: DragEvent): string[] {
  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return [];
  const paths: string[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index] as File & { path?: string };
    if (typeof file.path === 'string' && file.path) paths.push(file.path);
  }
  return paths;
}

function isHttpUrl(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

type TerminalPaneProps = {
  tab: Tab;
  group: Group;
  themeMode: TerminalThemeMode;
  shellLabel: string;
  active: boolean;
  focusTick: number;
  onRestart: (tab: Tab) => void;
  onClose: (tab: Tab) => void;
  onToast: (message: string, kind?: ToastKind) => void;
  onTerminalMenu: (event: ReactMouseEvent, tab: Tab, actions: TerminalMenuActions) => void;
  fontSize: number;
  copyOnSelect: boolean;
  onFontSizeDelta: (delta: number) => void;
};

export function TerminalPane({
  tab,
  group,
  themeMode,
  shellLabel,
  active,
  focusTick,
  onRestart,
  onClose,
  onToast,
  onTerminalMenu,
  fontSize,
  copyOnSelect,
  onFontSizeDelta,
}: TerminalPaneProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const actionsRef = useRef<TerminalMenuActions | null>(null);
  const activeRef = useRef(active);
  const themeModeRef = useRef(themeMode);
  const toastRef = useRef(onToast);
  const copyOnSelectRef = useRef(copyOnSelect);
  const onFontSizeDeltaRef = useRef(onFontSizeDelta);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const openFindRef = useRef(() => {});

  activeRef.current = active;
  themeModeRef.current = themeMode;
  toastRef.current = onToast;
  copyOnSelectRef.current = copyOnSelect;
  onFontSizeDeltaRef.current = onFontSizeDelta;
  openFindRef.current = () => setFindOpen(true);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let hoveredUri: string | null = null;
    const hoverLink = (_event: MouseEvent, uri: string) => {
      hoveredUri = uri;
    };
    const leaveLink = () => {
      hoveredUri = null;
    };
    const openHttpLink = (event: MouseEvent, uri: string) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (!isHttpUrl(uri)) return;
      void window.api.shell
        .openExternal(uri)
        .catch((error) => toastRef.current(toErrorMessage(error), 'error'));
    };

    const term = new Terminal({
      theme: terminalThemes[themeModeRef.current],
      // Codex paints its composer from the console palette; in the light theme
      // that leaves dark-on-dark input text unless contrast is enforced.
      minimumContrastRatio: themeModeRef.current === 'light' ? 4.5 : 1,
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei", monospace',
      fontSize,
      lineHeight: 1.35,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorInactiveStyle: 'outline',
      scrollback: 8000,
      smoothScrollDuration: 0,
      allowTransparency: false,
      fontWeight: '400',
      fontWeightBold: '600',
      // OSC 8 (Grok image paths) may be file:// or relative; hover/copy needs them.
      linkHandler: {
        activate: (event, uri) => openHttpLink(event, uri),
        hover: hoverLink,
        leave: leaveLink,
        allowNonHttpProtocols: true,
      },
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(
      new WebLinksAddon(openHttpLink, {
        hover: hoverLink,
        leave: leaveLink,
      }),
    );

    try {
      term.open(mount);
    } catch (error) {
      toastRef.current(toErrorMessage(error), 'error');
      return;
    }

    termRef.current = term;
    fitRef.current = fitAddon;
    searchRef.current = searchAddon;

    const copySelection = () => {
      if (!term.hasSelection()) return;
      const selection = term.getSelection();
      void window.api.clipboard
        .write(selection)
        .then(() => {
          term.clearSelection();
          toastRef.current('已复制选中内容', 'success');
        })
        .catch((error) => toastRef.current(toErrorMessage(error), 'error'));
    };

    const pasteClipboard = async () => {
      try {
        const text = await window.api.clipboard.read();
        if (text) term.paste(text);
      } catch (error) {
        toastRef.current(toErrorMessage(error), 'error');
      }
    };

    // 各家 CLI 的贴图键不同：OpenCode 自己用 PowerShell 读剪贴板，只认 ctrl+v；
    // 直接写 0x16 即可让 ConPTY 生成真正的 Ctrl+V 按键，不必走注入器。
    const pasteImageToPty = () => {
      if (tab.shellId === 'opencode') window.api.pty.write(tab.sessionId, String.fromCharCode(22));
      else window.api.pty.altV(tab.sessionId);
    };

    const pasteCtrlV = async () => {
      try {
        const hasImage = await window.api.clipboard.hasImage();
        if (hasImage) {
          pasteImageToPty();
          return;
        }
        await pasteClipboard();
      } catch (error) {
        toastRef.current(toErrorMessage(error), 'error');
      }
    };

    const copyLink = () => {
      if (!hoveredUri) return;
      void window.api.clipboard
        .write(hoveredUri)
        .then(() => toastRef.current('已复制链接', 'success'))
        .catch((error) => toastRef.current(toErrorMessage(error), 'error'));
    };

    const selectionDisposable = term.onSelectionChange(() => {
      if (!copyOnSelectRef.current || !term.hasSelection()) return;
      const selection = term.getSelection();
      if (!selection) return;
      void window.api.clipboard.write(selection).catch(() => {});
    });

    actionsRef.current = {
      hasSelection: () => term.hasSelection(),
      copySelection,
      paste: () => {
        void pasteClipboard();
      },
      selectAll: () => term.selectAll(),
      clear: () => term.clear(),
      hasLink: () => Boolean(hoveredUri),
      copyLink,
    };

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const key = event.key.toLowerCase();
      const copyCombo =
        (event.ctrlKey && !event.altKey && !event.metaKey && key === 'c') ||
        (event.ctrlKey && key === 'insert');
      if (copyCombo && term.hasSelection()) {
        event.preventDefault();
        copySelection();
        return false;
      }
      const isCtrlV = event.ctrlKey && !event.altKey && !event.metaKey && key === 'v';
      if (isCtrlV) {
        event.preventDefault();
        void pasteCtrlV();
        return false;
      }
      const isAltV = event.altKey && !event.ctrlKey && !event.metaKey && key === 'v';
      if (isAltV) {
        event.preventDefault();
        pasteImageToPty();
        return false;
      }
      if (event.ctrlKey && !event.altKey && !event.metaKey && key === 'f') {
        event.preventDefault();
        openFindRef.current();
        return false;
      }
      const isShiftInsert = event.shiftKey && !event.ctrlKey && !event.altKey && key === 'insert';
      if (isShiftInsert) {
        event.preventDefault();
        void pasteClipboard();
        return false;
      }
      return true;
    });

    const unsubscribe = subscribeData(tab.sessionId, (data) => term.write(data));
    const dataDisposable = term.onData((data) => window.api.pty.write(tab.sessionId, data));
    // 列数/行数没变就不要打扰 PTY：反复 resize 会让全屏 TUI 重绘，
    // 看起来像消息被重复输出了一遍。
    let lastCols = term.cols;
    let lastRows = term.rows;
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      window.api.pty.resize(tab.sessionId, cols, rows);
    });

    // One wheel notch scrolls exactly one line, like conhost. xterm turns a
    // pixel delta into several lines by cell height, so it is driven manually
    // in the normal buffer. Grok's full-screen views have no xterm scrollback
    // and crossterm reads native console mouse records, so the dead zone is
    // forwarded to the PTY instead of xterm's VT mouse reporting.
    let wheelAccumulator = 0;
    const handleWheel = (event: WheelEvent) => {
      if (!activeRef.current) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        onFontSizeDeltaRef.current(event.deltaY < 0 ? 1 : -1);
        return;
      }
      if (event.shiftKey) {
        // Shift+滚轮在 xterm 里是横向滚动，终端不支持，直接吞掉
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.deltaY === 0) {
        // 只有横向分量的手势（触控板横扫）同样不该让视图横移
        if (event.deltaX !== 0) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      const buffer = term.buffer.active;
      if (buffer.type !== 'normal' || term.modes.mouseTrackingMode !== 'none') return;
      event.preventDefault();
      event.stopPropagation();

      const unit = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? 100 : 1;
      wheelAccumulator += event.deltaY;
      while (Math.abs(wheelAccumulator) >= unit) {
        const step = wheelAccumulator < 0 ? -1 : 1;
        wheelAccumulator -= step * unit;
        if (buffer.baseY > 0) {
          term.scrollLines(step);
          continue;
        }
        let col = 0;
        let row = 0;
        const screen = mount.querySelector('.xterm-screen');
        const rect = screen?.getBoundingClientRect();
        if (rect && rect.width > 0 && rect.height > 0) {
          col = Math.max(0, Math.min(term.cols - 1, Math.floor(((event.clientX - rect.left) / rect.width) * term.cols)));
          row = Math.max(0, Math.min(term.rows - 1, Math.floor(((event.clientY - rect.top) / rect.height) * term.rows)));
        }
        window.api.pty.wheel(tab.sessionId, step < 0 ? 120 : -120, col, row);
      }
    };
    mount.addEventListener('wheel', handleWheel, { capture: true, passive: false });

    // Console UIs (Grok) never enable xterm's VT mouse reporting, so a left
    // click would only start a text selection. Forward it as a native console
    // record; the helper drops it when the console has no mouse input enabled,
    // which keeps plain CMD and PowerShell selection untouched.
    const handleMouseDown = (event: MouseEvent) => {
      if (!activeRef.current || event.button !== 0) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (term.modes.mouseTrackingMode !== 'none') return;
      const target = event.target;
      if (target instanceof Element && target.closest('.scrollbar')) return;
      const screen = mount.querySelector('.xterm-screen');
      const rect = screen?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      if (
        event.clientX < rect.left ||
        event.clientX >= rect.right ||
        event.clientY < rect.top ||
        event.clientY >= rect.bottom
      ) {
        return;
      }
      const col = Math.max(0, Math.min(term.cols - 1, Math.floor(((event.clientX - rect.left) / rect.width) * term.cols)));
      const row = Math.max(0, Math.min(term.rows - 1, Math.floor(((event.clientY - rect.top) / rect.height) * term.rows)));
      window.api.pty.click(tab.sessionId, col, row);
    };
    mount.addEventListener('mousedown', handleMouseDown, { capture: true });

    const handleDragOver = (event: DragEvent) => {
      if (!droppedFilePaths(event).length && !event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const handleDrop = (event: DragEvent) => {
      const paths = droppedFilePaths(event);
      if (!paths.length) return;
      event.preventDefault();
      event.stopPropagation();
      const text = formatDroppedPaths(paths);
      if (!text) return;
      term.paste(text);
      term.focus();
    };
    mount.addEventListener('dragover', handleDragOver, { capture: true });
    mount.addEventListener('drop', handleDrop, { capture: true });

    let frame = 0;
    // 收缩过的列数上限，用于避免 fit → 溢出 → 收缩 的反复震荡。
    // 容器宽度变化时清空，让终端能重新长回去。
    let shrinkLimit = 0;
    let lastMountWidth = 0;

    const fitNow = () => {
      if (!activeRef.current) return;
      if (!mount.isConnected || mount.clientWidth === 0 || mount.clientHeight === 0) return;
      if (mount.clientWidth !== lastMountWidth) {
        lastMountWidth = mount.clientWidth;
        shrinkLimit = 0;
      }
      try {
        fitAddon.fit();
      } catch {
        // the pane may be mid-transition
      }
      // fit() 按容器像素算列数，可能重新超出；这里压回上次收缩到的值，
      // 让终端稳定下来而不是来回跳。
      if (shrinkLimit > 0 && term.cols > shrinkLimit) {
        try {
          term.resize(shrinkLimit, term.rows);
        } catch {
          // ignore transient resize failures
        }
      }
      clampHorizontalScroll();
    };

    // xterm 6 的滚动容器允许横向滚动，且会自动横向滚动以跟随光标。
    // 中文字符实际渲染宽度可能超出理论单元格宽度，导致整行溢出、
    // 视图被推着往左跑（看起来像「飞出去」）。这里先按溢出的像素反算列数收一收，
    // 再把任何残留的横向偏移归零。
    const clampHorizontalScroll = () => {
      const scrollable = mount.querySelector('.xterm-scrollable-element');
      if (!scrollable) return;
      if (scrollable.scrollWidth > scrollable.clientWidth + 1) {
        const cellWidth = scrollable.clientWidth / Math.max(1, term.cols);
        const overflow = scrollable.scrollWidth - scrollable.clientWidth;
        const nextCols = Math.max(20, term.cols - Math.ceil(overflow / cellWidth));
        if (nextCols < term.cols) {
          shrinkLimit = shrinkLimit ? Math.min(shrinkLimit, nextCols) : nextCols;
          try {
            term.resize(nextCols, term.rows);
          } catch {
            // ignore transient resize failures
          }
        }
      }
      if (scrollable.scrollLeft !== 0) scrollable.scrollLeft = 0;
    };

    frame = requestAnimationFrame(() => {
      fitNow();
      if (activeRef.current) term.focus();
    });
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitNow);
    });
    observer.observe(mount);

    // xterm 自己也可能把 scrollLeft 挪走，任何滚动都拉回 0
    const scrollableHost = mount.querySelector('.xterm');
    const resetScrollLeft = () => {
      const scrollable = mount.querySelector('.xterm-scrollable-element');
      if (scrollable) scrollable.scrollLeft = 0;
    };
    scrollableHost?.addEventListener('scroll', resetScrollLeft, { capture: true, passive: true });

    void document.fonts?.ready.then(() => {
      if (termRef.current === term) fitNow();
    });

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      mount.removeEventListener('wheel', handleWheel, { capture: true });
      mount.removeEventListener('mousedown', handleMouseDown, { capture: true });
      mount.removeEventListener('dragover', handleDragOver, { capture: true });
      mount.removeEventListener('drop', handleDrop, { capture: true });
      scrollableHost?.removeEventListener('scroll', resetScrollLeft, { capture: true });
      unsubscribe();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      selectionDisposable.dispose();
      actionsRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      term.dispose();
    };
    // A new session id means a new terminal; everything else is handled through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.sessionId]);

  useEffect(() => {
    const term = termRef.current;
    const fitAddon = fitRef.current;
    if (!term || !fitAddon) return;
    term.options.fontSize = fontSize;
    try {
      fitAddon.fit();
    } catch {
      // pane may be hidden
    }
  }, [fontSize]);

  useEffect(() => {
    if (!findOpen) return;
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [findOpen]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = terminalThemes[themeMode];
    term.options.minimumContrastRatio = themeMode === 'light' ? 4.5 : 1;
  }, [themeMode]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // ignore transient layout states
      }
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, focusTick]);

  const copyPath = () => {
    void window.api.clipboard
      .write(tab.cwd)
      .then(() => toastRef.current('工作目录已复制', 'success'))
      .catch((error) => toastRef.current(toErrorMessage(error), 'error'));
  };

  const revealFolder = () => {
    void window.api.shell
      .reveal(tab.cwd)
      .catch((error) => toastRef.current(toErrorMessage(error), 'error'));
  };

  const openTerminalMenu = (event: ReactMouseEvent) => {
    const actions = actionsRef.current;
    if (!actions) return;
    event.preventDefault();
    onTerminalMenu(event, tab, actions);
  };

  return (
    <section
      className={`terminal-pane theme-${themeMode}${active ? '' : ' is-hidden'}`}
      aria-hidden={!active}
      data-testid="terminal-pane"
    >
      <header className="pane-header">
        <span
          className={`pane-dot${tab.exited ? ' exited' : ''}`}
          style={tab.exited ? undefined : { backgroundColor: group.color }}
        />
        <button
          type="button"
          className="pane-path"
          title={`${tab.cwd}（点击复制路径）`}
          onClick={copyPath}
        >
          <FolderOpen size={12} strokeWidth={1.8} />
          <span>{tab.cwd}</span>
          <Copy size={11} className="pane-path-copy" />
        </button>
        <div className="pane-actions">
          <span className="pane-shell" title={shellLabel}>
            {shellShortLabel(tab.shellId)}
          </span>
          <button
            type="button"
            className="icon-btn"
            title="清空屏幕"
            aria-label="清空屏幕"
            onClick={() => actionsRef.current?.clear()}
          >
            <Eraser size={14} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="重新启动终端"
            aria-label="重新启动终端"
            onClick={() => onRestart(tab)}
          >
            <RotateCw size={14} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="在资源管理器中打开"
            aria-label="在资源管理器中打开"
            onClick={revealFolder}
          >
            <FolderOpen size={15} />
          </button>
        </div>
      </header>
      {findOpen ? (
        <div className="find-bar">
          <Search size={13} />
          <input
            ref={findInputRef}
            value={findQuery}
            placeholder="查找"
            onChange={(event) => setFindQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                searchRef.current?.findNext(findQuery, { incremental: false });
              }
              if (event.key === 'Escape') {
                setFindOpen(false);
                termRef.current?.focus();
              }
            }}
          />
          <button
            type="button"
            className="icon-btn"
            title="下一个"
            onClick={() => searchRef.current?.findNext(findQuery)}
          >
            ↓
          </button>
          <button
            type="button"
            className="icon-btn"
            title="上一个"
            onClick={() => searchRef.current?.findPrevious(findQuery)}
          >
            ↑
          </button>
          <button
            type="button"
            className="icon-btn"
            title="关闭查找"
            onClick={() => {
              setFindOpen(false);
              termRef.current?.focus();
            }}
          >
            <X size={13} />
          </button>
        </div>
      ) : null}

      <div className="terminal-body" onContextMenu={openTerminalMenu}>
        <div className="terminal-mount" ref={mountRef} />
        {tab.exited ? (
          <div className="exit-overlay">
            <div className="exit-card">
              <div className="exit-icon">
                <SquareTerminal size={18} strokeWidth={1.7} />
              </div>
              <div className="exit-title">进程已结束</div>
              <div className="exit-sub">
                退出码 {tab.exitCode ?? 0} · {shellLabel}
              </div>
              <div className="exit-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => onRestart(tab)}
                >
                  重新启动
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => onClose(tab)}
                >
                  关闭页签
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
