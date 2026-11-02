import { useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../lib';
import { useCollapsedSection } from '../useCollapsedSection';

const DEFAULT_WIDTH = 220;
const MIN_WIDTH = 160;
const WIDTH_STORAGE_KEY = 'cmd-toolbox.editor.sidebar-width';

function readStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    if (raw === null) return DEFAULT_WIDTH;
    const value = Number(raw);
    // 非数字、比最小宽度还窄的旧值一律回落到默认宽度
    if (!Number.isFinite(value) || value < MIN_WIDTH) return DEFAULT_WIDTH;
    return Math.round(value);
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

type SidebarSectionProps = {
  id: string;
  title: string;
  grow?: boolean;
  children: ReactNode;
};

// 与侧栏其它折叠区同一套样式：section-header 是 <button>，
// 带 aria-expanded 和 .section-caret.is-open 箭头
function SidebarSection({ id, title, grow, children }: SidebarSectionProps): ReactElement {
  const [collapsed, toggle] = useCollapsedSection(id);

  return (
    <div className={`editor-sidebar-section${grow ? ' is-grow' : ''}`}>
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
      {collapsed ? null : children}
    </div>
  );
}

type EditorSidebarProps = {
  openEditors: ReactNode;
  fileTree: ReactNode;
};

export function EditorSidebar({ openEditors, fileTree }: EditorSidebarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(readStoredWidth);
  const widthRef = useRef(width);
  widthRef.current = width;
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
    const max = Math.max(MIN_WIDTH, body.getBoundingClientRect().width / 2);
    setWidth((current) => (current > max ? DEFAULT_WIDTH : current));
  }, []);

  const handleResizeDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
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
        <SidebarSection id="editor-file-tree" title="文件" grow>
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
