import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../lib';
import { useCollapsedSection } from '../useCollapsedSection';

const DEFAULT_WIDTH = 220;
const MIN_WIDTH = 160;
const WIDTH_STORAGE_KEY = 'cmd-toolbox.editor.sidebar-width';
// 每个编辑器页签各有一个 EditorSidebar，拖完一个要通知其它实例同步
const WIDTH_CHANGE_EVENT = 'editor-sidebar-width-change';

function isUsableWidth(value: number): boolean {
  return Number.isFinite(value) && value >= MIN_WIDTH;
}

function readStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    if (raw === null) return DEFAULT_WIDTH;
    // 非数字、比最小宽度还窄的旧值一律回落到默认宽度
    if (!isUsableWidth(Number(raw))) return DEFAULT_WIDTH;
    return Math.round(Number(raw));
  } catch {
    return DEFAULT_WIDTH;
  }
}

function persistWidth(width: number) {
  try {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // 存不进去只影响下次启动的宽度，不值得打断交互
  }
}

// 侧栏所在容器的宽度一半就是上限。隐藏的页签是 display:none，量出来是 0，
// 这时不能把上限当成 160——否则未激活的 EditorPane 会把同步来的宽度夹成最小宽度。
function maxWidthFor(element: HTMLElement | null | undefined): number {
  const measured = element?.getBoundingClientRect().width ?? 0;
  return measured > 0 ? Math.max(MIN_WIDTH, measured / 2) : Infinity;
}

type SidebarSectionProps = {
  id: string;
  title: string;
  grow?: boolean;
  // 放在标题行右侧的操作按钮（文件区的新建/刷新/折叠）
  actions?: ReactNode;
  children: ReactNode;
};

// 与侧栏其它折叠区同一套样式：section-header 是 <button>，
// 带 aria-expanded 和 .section-caret.is-open 箭头
function SidebarSection({
  id,
  title,
  grow,
  actions,
  children,
}: SidebarSectionProps): ReactElement {
  const [collapsed, toggle] = useCollapsedSection(id);

  const header = (
    <button
      type="button"
      className="section-header"
      aria-expanded={!collapsed}
      title={collapsed ? `展开${title}` : `收起${title}`}
      onClick={toggle}
    >
      <ChevronRight
        size={12}
        className={cn('section-caret', !collapsed && 'is-open')}
      />
      <span className="section-title">{title}</span>
    </button>
  );

  return (
    <div className={`editor-sidebar-section${grow ? ' is-grow' : ''}`}>
      {actions ? (
        // button 不能嵌套 button：有操作按钮时标题与它们并排成一行
        <div className="section-header-row">
          {header}
          <div className="section-actions">{actions}</div>
        </div>
      ) : (
        header
      )}
      {collapsed ? null : children}
    </div>
  );
}

type EditorSidebarProps = {
  openEditors: ReactNode;
  fileTree: ReactNode;
  fileActions?: ReactNode;
};

export function EditorSidebar({ openEditors, fileTree, fileActions }: EditorSidebarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(readStoredWidth);
  const widthRef = useRef(width);
  useEffect(() => {
    widthRef.current = width;
  }, [width]);
  const [dragging, setDragging] = useState(false);
  // 起始 x、起始宽度与这一轮允许的最大宽度，按下时定格
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    currentWidth: number;
    max: number;
  } | null>(null);

  // 挂载时按容器实测宽度校验一次持久值：超过容器一半的旧值（比如换了小窗口）
  // 会把编辑器挤没，直接回落到默认宽度。
  useLayoutEffect(() => {
    const body = rootRef.current?.parentElement;
    if (!body) return;
    const max = maxWidthFor(body);
    if (Number.isFinite(max) && widthRef.current > max) {
      // 回写，否则窗口变宽后再刷新，这个放不下的旧值又会复活
      persistWidth(DEFAULT_WIDTH);
      setWidth(DEFAULT_WIDTH);
    }
  }, []);

  // 其它实例拖完宽度后同步过来。这里只 setWidth，不再 dispatch，避免来回触发。
  // storage 事件只在其它窗口写入时触发，同窗口仍靠上面的自定义事件。
  useEffect(() => {
    const applySharedWidth = (next: number) => {
      if (!isUsableWidth(next)) return;
      const max = maxWidthFor(rootRef.current?.parentElement);
      setWidth(Math.round(Math.min(next, max)));
    };
    const handleWidthChange = (event: Event) => {
      applySharedWidth((event as CustomEvent<number>).detail);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== WIDTH_STORAGE_KEY || event.newValue === null) return;
      applySharedWidth(Number(event.newValue));
    };
    window.addEventListener(WIDTH_CHANGE_EVENT, handleWidthChange);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(WIDTH_CHANGE_EVENT, handleWidthChange);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const handleResizeDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const body = rootRef.current?.parentElement;
    if (!body) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    dragRef.current = {
      startX: event.clientX,
      startWidth: widthRef.current,
      currentWidth: widthRef.current,
      max: Math.max(MIN_WIDTH, body.getBoundingClientRect().width / 2),
    };
  };

  const handleResizeMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || event.buttons === 0) return;
    const next = Math.round(
      Math.min(drag.max, Math.max(MIN_WIDTH, drag.startWidth + (event.clientX - drag.startX))),
    );
    drag.currentWidth = next;
    setWidth((current) => (current === next ? current : next));
  };

  const handleResizeUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current) return;
    const { currentWidth } = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    // 只在松手时落盘，拖动过程中每帧写 localStorage 没有必要
    persistWidth(currentWidth);
    window.dispatchEvent(
      new CustomEvent<number>(WIDTH_CHANGE_EVENT, { detail: currentWidth }),
    );
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
  };

  return (
    <>
      <div
        ref={rootRef}
        className="editor-sidebar"
        style={{ flex: `0 0 ${width}px` }}
      >
        <SidebarSection id="editor-open-editors" title="打开的编辑器">
          {openEditors}
        </SidebarSection>
        <SidebarSection id="editor-file-tree" title="文件" grow actions={fileActions}>
          {fileTree}
        </SidebarSection>
      </div>
      <button
        type="button"
        className={`split-resizer${dragging ? ' is-dragging' : ''}`}
        aria-label="调整侧栏宽度"
        onPointerDown={handleResizeDown}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeUp}
        onPointerCancel={handleResizeUp}
      />
    </>
  );
}
