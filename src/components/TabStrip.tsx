import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { ChevronDown, FileCode2, Plus, X } from 'lucide-react';
import { cn } from '../lib';
import { groupRuns, type TabRun } from '../tabGroups';
import { MODEL_STATUS_LABEL, type ModelStatus } from '../sessionStatus';
import type { Group, Tab, TabGroup } from '../types';
import { TabGroupLabel } from './TabGroupLabel';

export const TAB_DRAG_TYPE = 'text/cmd-toolbox-tab';
export const TAB_GROUP_DRAG_TYPE = 'text/cmd-toolbox-tabgroup';

type TabStripProps = {
  group: Group;
  tabs: Tab[];
  tabGroups?: TabGroup[];
  activeTabId: string | null;
  rightTabIds?: string[];
  rightActiveTabId?: string | null;
  canChooseShell: boolean;
  renamingGroupId?: string | null;
  modelStatusBySession?: Record<string, ModelStatus>;
  unreadBySession?: Record<string, boolean>;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onTabMenu: (event: ReactMouseEvent, tab: Tab) => void;
  onRenameTab: (tab: Tab) => void;
  onNewTab: () => void;
  onNewEditor: () => void;
  onShellMenu: (event: ReactMouseEvent) => void;
  onReorderTabs: (
    fromTabId: string,
    toTabId: string,
    position: 'before' | 'after',
    tabGroupId: string | null,
  ) => void;
  onPlaceTab?: (
    fromTabId: string,
    toTabId: string | null,
    position: 'before' | 'after',
    tabGroupId: string | null,
  ) => void;
  onMoveTabGroup?: (groupId: string, toTabId: string | null, position: 'before' | 'after') => void;
  onToggleGroup: (groupId: string) => void;
  onGroupMenu: (event: ReactMouseEvent, group: TabGroup) => void;
  onStartGroupRename: (groupId: string) => void;
  onCommitGroupRename: (groupId: string, name: string) => void;
  onCancelGroupRename: () => void;
};

function isTabDrag(event: ReactDragEvent) {
  return Array.from(event.dataTransfer.types).includes(TAB_DRAG_TYPE);
}

function isTabGroupDrag(event: ReactDragEvent) {
  return Array.from(event.dataTransfer.types).includes(TAB_GROUP_DRAG_TYPE);
}

export function TabStrip({
  group,
  tabs,
  tabGroups = [],
  activeTabId,
  rightTabIds = [],
  rightActiveTabId = null,
  canChooseShell,
  renamingGroupId = null,
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
  onMoveTabGroup,
  onToggleGroup,
  onGroupMenu,
  onStartGroupRename,
  onCommitGroupRename,
  onCancelGroupRename,
}: TabStripProps) {
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const draggingIdRef = useRef<string | null>(null);
  const draggingGroupIdRef = useRef<string | null>(null);
  const dropHintRef = useRef<{ id: string; position: 'before' | 'after' } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; position: 'before' | 'after' } | null>(
    null,
  );
  const [dropGroupId, setDropGroupId] = useState<string | null>(null);

  const runs = useMemo(() => groupRuns(tabs, tabGroups), [tabs, tabGroups]);
  const groupByTabId = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const run of runs) {
      for (const tab of run.tabs) map.set(tab.id, run.group?.id ?? null);
    }
    return map;
  }, [runs]);

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
    draggingGroupIdRef.current = null;
    dropHintRef.current = null;
    setDraggingId(null);
    setDraggingGroupId(null);
    setDropHint(null);
    setDropGroupId(null);
  };

  const handleGroupDragStart = (event: ReactDragEvent, run: TabRun) => {
    if (!run.group) return;
    event.dataTransfer.setData(TAB_GROUP_DRAG_TYPE, run.group.id);
    event.dataTransfer.effectAllowed = 'move';
    draggingGroupIdRef.current = run.group.id;
    setDraggingGroupId(run.group.id);
    updateDropHint(null);
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
    const groupDrag = Boolean(draggingGroupIdRef.current) || isTabGroupDrag(event);
    if (!draggingIdRef.current && !groupDrag && !isTabDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropGroupId(null);
    if (draggingIdRef.current === tab.id) {
      updateDropHint(null);
      return;
    }
    // 拖的是组本身时，落在自己组内的页签上没有意义
    if (draggingGroupIdRef.current && groupByTabId.get(tab.id) === draggingGroupIdRef.current) {
      updateDropHint(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    updateDropHint({ id: tab.id, position });
  };

  const handleDrop = (event: ReactDragEvent, tab: Tab) => {
    const movedGroupId =
      draggingGroupIdRef.current || event.dataTransfer.getData(TAB_GROUP_DRAG_TYPE) || null;
    if (movedGroupId && onMoveTabGroup) {
      event.preventDefault();
      event.stopPropagation();
      const hint = dropHintRef.current;
      const position = hint?.id === tab.id ? hint.position : 'before';
      updateDropHint(null);
      setDropGroupId(null);
      onMoveTabGroup(movedGroupId, tab.id, position);
      return;
    }
    const fromId = draggingIdRef.current || event.dataTransfer.getData(TAB_DRAG_TYPE);
    if (!fromId) return;
    event.preventDefault();
    event.stopPropagation();
    const hint = dropHintRef.current;
    const position = hint?.id === tab.id ? hint.position : 'before';
    const tabGroupId = groupByTabId.get(tab.id) ?? null;
    updateDropHint(null);
    setDropGroupId(null);
    if (onPlaceTab) onPlaceTab(fromId, tab.id, position, tabGroupId);
    else onReorderTabs(fromId, tab.id, position, tabGroupId);
  };

  // 拖到组标题上：直接落到该组末尾，不必精确找位置
  const handleGroupDragOver = (event: ReactDragEvent, run: TabRun) => {
    if (!run.group) return;
    const groupDrag = Boolean(draggingGroupIdRef.current) || isTabGroupDrag(event);
    if (!groupDrag && !isTabDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    updateDropHint(null);
    // 拖自己这一组的标题不算落点
    if (groupDrag && draggingGroupIdRef.current === run.group.id) {
      setDropGroupId(null);
      return;
    }
    setDropGroupId(run.group.id);
  };

  const handleGroupDrop = (event: ReactDragEvent, run: TabRun) => {
    if (!run.group) return;
    const movedGroupId =
      draggingGroupIdRef.current || event.dataTransfer.getData(TAB_GROUP_DRAG_TYPE) || null;
    if (movedGroupId && onMoveTabGroup) {
      event.preventDefault();
      event.stopPropagation();
      const last = run.tabs[run.tabs.length - 1];
      updateDropHint(null);
      setDropGroupId(null);
      if (movedGroupId !== run.group.id) onMoveTabGroup(movedGroupId, last.id, 'after');
      return;
    }
    const fromId = draggingIdRef.current || event.dataTransfer.getData(TAB_DRAG_TYPE);
    if (!fromId) return;
    event.preventDefault();
    event.stopPropagation();
    const last = run.tabs[run.tabs.length - 1];
    updateDropHint(null);
    setDropGroupId(null);
    if (onPlaceTab) onPlaceTab(fromId, last.id, 'after', run.group.id);
    else onReorderTabs(fromId, last.id, 'after', run.group.id);
  };

  // 拖到空白处 = 移出所在标签组；拖一个组到空白处 = 整组挪到最后
  const handleStripDrop = (event: ReactDragEvent) => {
    const movedGroupId =
      draggingGroupIdRef.current || event.dataTransfer.getData(TAB_GROUP_DRAG_TYPE) || null;
    if (movedGroupId && onMoveTabGroup) {
      event.preventDefault();
      updateDropHint(null);
      setDropGroupId(null);
      onMoveTabGroup(movedGroupId, null, 'after');
      return;
    }
    const fromId = draggingIdRef.current || event.dataTransfer.getData(TAB_DRAG_TYPE);
    if (!fromId) return;
    event.preventDefault();
    updateDropHint(null);
    setDropGroupId(null);
    if (!onPlaceTab) return;
    onPlaceTab(fromId, null, 'after', null);
  };

  const renderTab = (tab: Tab) => {
    const active = tab.id === activeTabId || tab.id === rightActiveTabId;
    const modelStatus = modelStatusBySession[tab.sessionId];
    const showLamp = Boolean(modelStatus);
    const unread = Boolean(unreadBySession[tab.sessionId]);
    const inGroup = Boolean(groupByTabId.get(tab.id));
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
          inGroup && 'in-group',
          rightTabIds.includes(tab.id) && 'is-right',
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
              className={cn('tab-lamp', `is-${modelStatus}`, unread && 'is-unread')}
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
  };

  return (
    <div className="tabstrip">
      <div
        className="tabs-scroll"
        role="tablist"
        aria-label={`${group.name} 的终端页签`}
        onDragOver={(event) => {
          const groupDrag = Boolean(draggingGroupIdRef.current) || isTabGroupDrag(event);
          if (!groupDrag && !draggingIdRef.current && !isTabDrag(event)) return;
          if (!groupDrag && !onPlaceTab) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }}
        onDrop={handleStripDrop}
        onDragLeave={(event) => {
          const related = event.relatedTarget;
          if (related instanceof Node && event.currentTarget.contains(related)) return;
          updateDropHint(null);
          setDropGroupId(null);
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

        {runs.map((run) => {
          if (!run.group) return run.tabs.map((tab) => renderTab(tab));
          const groupView = run.group;
          return (
            <div
              key={run.key}
              className={cn(
                'tab-group',
                groupView.collapsed && 'is-collapsed',
                dropGroupId === groupView.id && 'is-drop-target',
                draggingGroupId === groupView.id && 'is-dragging',
              )}
              data-color={groupView.color}
            >
              <TabGroupLabel
                group={groupView}
                count={run.tabs.length}
                editing={renamingGroupId === groupView.id}
                onToggle={() => onToggleGroup(groupView.id)}
                onStartRename={() => onStartGroupRename(groupView.id)}
                onCommitRename={(name) => onCommitGroupRename(groupView.id, name)}
                onCancelRename={onCancelGroupRename}
                onMenu={(event) => onGroupMenu(event, groupView)}
                onDragStart={(event) => handleGroupDragStart(event, run)}
                onDragEnd={clearDragState}
                onDragOver={(event) => handleGroupDragOver(event, run)}
                onDragLeave={(event) => {
                  const related = event.relatedTarget;
                  if (related instanceof Node && event.currentTarget.contains(related)) return;
                  setDropGroupId(null);
                }}
                onDrop={(event) => handleGroupDrop(event, run)}
              />
              {/* 折叠靠 1fr→0fr 过渡，不能卸载 DOM，否则没有动画可播 */}
              <div
                className={cn(
                  'tab-group-tabs',
                  groupView.collapsed && 'is-collapsed',
                )}
                aria-hidden={groupView.collapsed}
              >
                <div className="tab-group-tabs-inner">
                  {run.tabs.map((tab) => renderTab(tab))}
                </div>
              </div>
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
