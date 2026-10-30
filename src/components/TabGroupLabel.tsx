import { useRef } from 'react';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { cn } from '../lib';
import { TAB_GROUP_NAME_LIMIT } from '../tabGroups';
import type { TabGroup } from '../types';

type TabGroupLabelProps = {
  group: TabGroup;
  count: number;
  editing: boolean;
  onToggle: () => void;
  onStartRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onMenu: (event: ReactMouseEvent) => void;
  onDragStart: (event: ReactDragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (event: ReactDragEvent) => void;
  onDragLeave: (event: ReactDragEvent) => void;
  onDrop: (event: ReactDragEvent) => void;
};

export function TabGroupLabel({
  group,
  count,
  editing,
  onToggle,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: TabGroupLabelProps) {
  const cancelledRef = useRef(false);

  return (
    <div
      className={cn('tab-group-label', group.collapsed && 'is-collapsed')}
      data-color={group.color}
      // 拖动整个组靠拖标题：组内页签自己可拖，会先一步截获拖拽
      draggable={!editing}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMenu(event);
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {editing ? (
        <input
          className="tab-group-input"
          autoFocus
          defaultValue={group.name}
          maxLength={TAB_GROUP_NAME_LIMIT}
          aria-label="标签组名称"
          onFocus={(event) => event.currentTarget.select()}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelledRef.current = true;
              event.currentTarget.blur();
            }
          }}
          onBlur={(event) => {
            if (cancelledRef.current) {
              cancelledRef.current = false;
              onCancelRename();
              return;
            }
            onCommitRename(event.currentTarget.value);
          }}
        />
      ) : (
        <button
          type="button"
          className="tab-group-toggle"
          title={`${group.name}${group.collapsed ? '（已折叠）' : ''} · 单击${group.collapsed ? '展开' : '折叠'}，双击重命名`}
          aria-label={`标签组 ${group.name}`}
          aria-expanded={!group.collapsed}
          onClick={onToggle}
          onDoubleClick={(event) => {
            event.stopPropagation();
            onStartRename();
          }}
        >
          <span className="tab-group-dot" aria-hidden="true" />
          <span className="tab-group-name">{group.name}</span>
          {group.collapsed ? <span className="tab-group-count">{count}</span> : null}
        </button>
      )}
    </div>
  );
}
