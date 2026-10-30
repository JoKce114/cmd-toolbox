import { useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { ChevronDown, FileCode2, Plus, X } from 'lucide-react';
import { cn } from '../lib';
import { MODEL_STATUS_LABEL, type ModelStatus } from '../sessionStatus';
import type { Group, Tab } from '../types';

export const TAB_DRAG_TYPE = 'text/cmd-toolbox-tab';

type TabStripProps = {
  group: Group;
  tabs: Tab[];
  activeTabId: string | null;
  rightTabIds?: string[];
  rightActiveTabId?: string | null;
  canChooseShell: boolean;
  modelStatusBySession?: Record<string, ModelStatus>;
  unreadBySession?: Record<string, boolean>;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onTabMenu: (event: ReactMouseEvent, tab: Tab) => void;
  onRenameTab: (tab: Tab) => void;
  onNewTab: () => void;
  onNewEditor: () => void;
  onShellMenu: (event: ReactMouseEvent) => void;
  onReorderTabs: (fromTabId: string, toTabId: string, position: 'before' | 'after') => void;
  onPlaceTab?: (
    fromTabId: string,
    toTabId: string | null,
    position: 'before' | 'after',
  ) => void;
};

function isTabDrag(event: ReactDragEvent) {
  return Array.from(event.dataTransfer.types).includes(TAB_DRAG_TYPE);
}

export function TabStrip({
  group,
  tabs,
  activeTabId,
  rightTabIds = [],
  rightActiveTabId = null,
  canChooseShell,
  modelStatusBySession = {},
  unreadBySession = {},
  onSelectTab,
  onCloseTab,
  onTabMenu,
  onRenameTab,
  onNewTab,
  onNewEditor,
  onShellMenu,
  onReorderTabs,
  onPlaceTab,
}: TabStripProps) {
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const draggingIdRef = useRef<string | null>(null);
  const dropHintRef = useRef<{ id: string; position: 'before' | 'after' } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; position: 'before' | 'after' } | null>(
    null,
  );

  useEffect(() => {
    if (!activeTabId) return;
    tabRefs.current.get(activeTabId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs.length]);

  const updateDropHint = (hint: { id: string; position: 'before' | 'after' } | null) => {
    dropHintRef.current = hint;
    setDropHint((current) =>
      current?.id === hint?.id && current?.position === hint?.position ? current : hint,
    );
  };

  const clearDragState = () => {
    draggingIdRef.current = null;
    dropHintRef.current = null;
    setDraggingId(null);
    setDropHint(null);
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent, tab: Tab) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelectTab(tab.id);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = tabs.findIndex((item) => item.id === tab.id);
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(index + offset + tabs.length) % tabs.length];
    if (next) onSelectTab(next.id);
  };

  const handleDragStart = (event: ReactDragEvent, tab: Tab) => {
    if ((event.target as HTMLElement).closest('.tab-close')) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
    event.dataTransfer.effectAllowed = 'move';
    draggingIdRef.current = tab.id;
    setDraggingId(tab.id);
    updateDropHint(null);
  };

  const handleDragOver = (event: ReactDragEvent, tab: Tab) => {
    if (!draggingIdRef.current && !isTabDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (draggingIdRef.current === tab.id) {
      updateDropHint(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    updateDropHint({ id: tab.id, position });
  };

  const handleDrop = (event: ReactDragEvent, tab: Tab) => {
    const fromId = draggingIdRef.current || event.dataTransfer.getData(TAB_DRAG_TYPE);
    if (!fromId) return;
    event.preventDefault();
    event.stopPropagation();
    const hint = dropHintRef.current;
    const position = hint?.id === tab.id ? hint.position : 'before';
    updateDropHint(null);
    if (onPlaceTab) onPlaceTab(fromId, tab.id, position);
    else onReorderTabs(fromId, tab.id, position);
  };

  const handleStripDrop = (event: ReactDragEvent) => {
    if (!onPlaceTab) return;
    const fromId = draggingIdRef.current || event.dataTransfer.getData(TAB_DRAG_TYPE);
    if (!fromId) return;
    event.preventDefault();
    updateDropHint(null);
    onPlaceTab(fromId, null, 'after');
  };

  return (
    <div className="tabstrip">
      <div
        className="tabs-scroll"
        role="tablist"
        aria-label={`${group.name} 的终端页签`}
        onDragOver={(event) => {
          if (!onPlaceTab) return;
          if (!draggingIdRef.current && !isTabDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }}
        onDrop={handleStripDrop}
        onDragLeave={(event) => {
          const related = event.relatedTarget;
          if (related instanceof Node && event.currentTarget.contains(related)) return;
          updateDropHint(null);
        }}
      >
        {tabs.length === 0 ? (
          <div className="tab-empty-label">
            <span
              className="tab-empty-dot"
              style={{ backgroundColor: group.exists ? group.color : '#c3a15a' }}
            />
            <span>{group.name}</span>
            <span className="tab-empty-hint">暂无终端</span>
          </div>
        ) : null}

        {tabs.map((tab) => {
          const onRight = rightTabIds.includes(tab.id);
          const active = tab.id === activeTabId || tab.id === rightActiveTabId;
          const modelStatus = modelStatusBySession[tab.sessionId];
          const showLamp = Boolean(modelStatus);
          const unread = Boolean(unreadBySession[tab.sessionId]);
          return (
            <div
              key={tab.id}
              ref={(node) => {
                if (node) tabRefs.current.set(tab.id, node);
                else tabRefs.current.delete(tab.id);
              }}
              className={cn(
                'tab',
                active && 'active',
                onRight && 'is-right',
                tab.exited && 'exited',
                draggingId === tab.id && 'is-dragging',
                dropHint && dropHint.id === tab.id && dropHint.position === 'before' && 'drop-before',
                dropHint && dropHint.id === tab.id && dropHint.position === 'after' && 'drop-after',
              )}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              draggable
              title={`#${tab.paneNo} · ${group.name} · ${tab.descriptor}\n${tab.cwd}\n双击重命名用途`}
              onClick={() => onSelectTab(tab.id)}
              onDoubleClick={() => onRenameTab(tab)}
              onContextMenu={(event) => onTabMenu(event, tab)}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onCloseTab(tab.id);
                }
              }}
              onKeyDown={(event) => handleTabKeyDown(event, tab)}
              onDragStart={(event) => handleDragStart(event, tab)}
              onDragEnter={(event) => handleDragOver(event, tab)}
              onDragOver={(event) => handleDragOver(event, tab)}
              onDrop={(event) => handleDrop(event, tab)}
              onDragEnd={clearDragState}
            >
              {/* 项目色点在同组里颜色一致、标题也写着项目名，只在退出且没有状态灯时留一个灰点 */}
              {tab.exited && !showLamp ? <span className="tab-dot" /> : null}
              <span className="tab-title">
                {showLamp ? (
                  <span
                    className={cn(
                      'tab-lamp',
                      `is-${modelStatus}`,
                      unread && 'is-unread',
                    )}
                    title={
                      unread
                        ? `${MODEL_STATUS_LABEL[modelStatus]}（已完成，未查看）`
                        : MODEL_STATUS_LABEL[modelStatus]
                    }
                    aria-label={MODEL_STATUS_LABEL[modelStatus]}
                  />
                ) : null}
                <span className="tab-pane">#{tab.paneNo}</span>
                <span className="tab-project">{group.name}</span>
                <span className="tab-sep">·</span>
                <span className="tab-func">{tab.descriptor}</span>
              </span>
              <button
                type="button"
                className="tab-close"
                aria-label={`关闭 #${tab.paneNo} · ${group.name} · ${tab.descriptor}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="tab-strip-new">
        <button
          type="button"
          className="new-editor-btn"
          title="新建编辑器"
          aria-label="新建编辑器"
          disabled={!group.exists}
          onClick={onNewEditor}
        >
          <FileCode2 size={14} strokeWidth={1.8} />
          <span>新建编辑器</span>
        </button>
        <div className={cn('new-terminal', !canChooseShell && 'single')}>
          <button
            type="button"
            className="new-terminal-main"
            title="新建终端 (Ctrl+T)"
            onClick={onNewTab}
          >
            <Plus size={14} strokeWidth={2} />
            <span>新建终端</span>
          </button>
          {canChooseShell ? (
            <button
              type="button"
              className="new-terminal-caret"
              title="选择终端类型"
              aria-label="选择终端类型"
              onClick={onShellMenu}
            >
              <ChevronDown size={13} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
