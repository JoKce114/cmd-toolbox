import { useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  FolderPlus,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  SquareTerminal,
} from 'lucide-react';
import { cn } from '../lib';
import { tint } from '../theme';
import { useCollapsedSection } from '../useCollapsedSection';
import type { Group } from '../types';
import { MODEL_STATUS_LABEL, type ModelStatus } from '../sessionStatus';

const PROJECT_DRAG_TYPE = 'text/cmd-toolbox-project';

type GroupRowProps = {
  group: Group;
  count: number;
  active: boolean;
  global?: boolean;
  reorderable?: boolean;
  dragging?: boolean;
  dropPosition?: 'before' | 'after' | null;
  modelStatus?: ModelStatus;
  onSelect: () => void;
  onQuickOpen: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
  onDragStart?: (event: ReactDragEvent) => void;
  onDragOver?: (event: ReactDragEvent) => void;
  onDrop?: (event: ReactDragEvent) => void;
  onDragEnd?: () => void;
};

function GroupRow({
  group,
  count,
  active,
  global = false,
  reorderable = false,
  dragging = false,
  dropPosition = null,
  modelStatus = 'idle',
  onSelect,
  onQuickOpen,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: GroupRowProps) {
  const initial = group.name.trim().charAt(0).toUpperCase();

  return (
    <div
      className={cn(
        'group-item',
        active && 'active',
        global && 'global-row',
        !group.exists && !global && 'invalid',
        dragging && 'is-dragging',
        dropPosition === 'before' && 'drop-before',
        dropPosition === 'after' && 'drop-after',
      )}
      draggable={reorderable}
      onContextMenu={onContextMenu}
      onDragStart={reorderable ? onDragStart : undefined}
      onDragEnter={reorderable ? onDragOver : undefined}
      onDragOver={reorderable ? onDragOver : undefined}
      onDrop={reorderable ? onDrop : undefined}
      onDragEnd={reorderable ? onDragEnd : undefined}
    >
      <button
        type="button"
        className="group-main"
        onClick={onSelect}
        title={`${group.name}\n${group.path}`}
      >
        <span
          className={cn('group-avatar', global && 'global')}
          style={
            global
              ? undefined
              : { backgroundColor: tint(group.color, '16'), color: group.color }
          }
        >
          {global ? <SquareTerminal size={15} strokeWidth={1.8} /> : initial || '·'}
        </span>
        <span className="group-text">
          <span className="group-name">
            <span
              className={cn('group-lamp', `is-${modelStatus}`)}
              title={MODEL_STATUS_LABEL[modelStatus]}
              aria-label={MODEL_STATUS_LABEL[modelStatus]}
            />
            <span className="group-name-text">{group.name}</span>
            {!group.exists && !global ? (
              <AlertTriangle
                size={12}
                className="group-warning"
                aria-label="目录不存在"
              />
            ) : null}
          </span>
        </span>
        {count > 0 ? <span className="group-count">{count}</span> : null}
      </button>
      <button
        type="button"
        className="group-quick-add"
        title={group.exists ? '新建终端' : '项目目录不存在'}
        aria-label={`在 ${group.name} 中新建终端`}
        disabled={!group.exists}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onQuickOpen();
        }}
      >
        <Plus size={13} strokeWidth={2} />
      </button>
    </div>
  );
}

type SidebarProps = {
  groups: Group[];
  activeKey: string;
  counts: Record<string, number>;
  modelStatusByGroup: Record<string, ModelStatus>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelectGroup: (key: string) => void;
  onQuickOpen: (group: Group) => void;
  onGroupMenu: (event: ReactMouseEvent, group: Group) => void;
  onAddProject: () => void;
  onReorderProjects: (
    fromProjectId: string,
    toProjectId: string,
    position: 'before' | 'after',
  ) => void;
  gitPanel: ReactNode;
};

function isProjectDrag(event: ReactDragEvent) {
  return Array.from(event.dataTransfer.types).includes(PROJECT_DRAG_TYPE);
}

export function Sidebar({
  groups,
  activeKey,
  counts,
  modelStatusByGroup,
  collapsed,
  onToggleCollapsed,
  onSelectGroup,
  onQuickOpen,
  onGroupMenu,
  onAddProject,
  onReorderProjects,
  gitPanel,
}: SidebarProps) {
  const globalGroup = groups.find((group) => group.kind === 'global');
  const projects = groups.filter((group) => group.kind === 'project');
  const [projectsCollapsed, toggleProjects] = useCollapsedSection('projects');
  const draggingIdRef = useRef<string | null>(null);
  const dropHintRef = useRef<{ id: string; position: 'before' | 'after' } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; position: 'before' | 'after' } | null>(
    null,
  );

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

  const handleProjectDragStart = (event: ReactDragEvent, group: Group) => {
    if (!group.projectId || (event.target as HTMLElement).closest('.group-quick-add')) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(PROJECT_DRAG_TYPE, group.projectId);
    event.dataTransfer.effectAllowed = 'move';
    draggingIdRef.current = group.projectId;
    setDraggingId(group.projectId);
    updateDropHint(null);
  };

  const handleProjectDragOver = (event: ReactDragEvent, group: Group) => {
    const projectId = group.projectId;
    if (!projectId || (!draggingIdRef.current && !isProjectDrag(event))) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (draggingIdRef.current === projectId) {
      updateDropHint(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    updateDropHint({ id: projectId, position });
  };

  const handleProjectDrop = (event: ReactDragEvent, group: Group) => {
    if (!group.projectId) return;
    const fromId = draggingIdRef.current || event.dataTransfer.getData(PROJECT_DRAG_TYPE);
    if (!fromId) return;
    event.preventDefault();
    event.stopPropagation();
    const hint = dropHintRef.current;
    const position = hint?.id === group.projectId ? hint.position : 'before';
    updateDropHint(null);
    onReorderProjects(fromId, group.projectId, position);
  };

  return (
    <aside className={cn('sidebar', collapsed && 'is-collapsed')}>
      <button
        type="button"
        className="sidebar-toggle"
        title={collapsed ? '展开侧栏' : '收起侧栏'}
        aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
        aria-expanded={!collapsed}
        onClick={onToggleCollapsed}
      >
        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </button>
      <div className="sidebar-scroll">
        {globalGroup ? (
          <GroupRow
            group={globalGroup}
            count={counts[globalGroup.key] || 0}
            modelStatus={modelStatusByGroup[globalGroup.key] || 'idle'}
            active={activeKey === globalGroup.key}
            global
            onSelect={() => onSelectGroup(globalGroup.key)}
            onQuickOpen={() => onQuickOpen(globalGroup)}
            onContextMenu={(event) => onGroupMenu(event, globalGroup)}
          />
        ) : null}

        <button
          type="button"
          className="section-header"
          aria-expanded={!projectsCollapsed}
          title={projectsCollapsed ? '展开项目列表' : '收起项目列表'}
          onClick={toggleProjects}
        >
          <ChevronRight
            size={12}
            className={cn('section-caret', !projectsCollapsed && 'is-open')}
          />
          <span className="section-title">项目</span>
          <span className="section-count">{projects.length}</span>
        </button>

        <div
          className={cn('projects-scroll', projectsCollapsed && 'is-hidden')}
          onDragLeave={(event) => {
            const related = event.relatedTarget;
            if (related instanceof Node && event.currentTarget.contains(related)) return;
            updateDropHint(null);
          }}
        >
          {projects.map((group) => (
            <GroupRow
              key={group.key}
              group={group}
              count={counts[group.key] || 0}
              modelStatus={modelStatusByGroup[group.key] || 'idle'}
              active={activeKey === group.key}
              reorderable
              dragging={draggingId === group.projectId}
              dropPosition={dropHint && dropHint.id === group.projectId ? dropHint.position : null}
              onSelect={() => onSelectGroup(group.key)}
              onQuickOpen={() => onQuickOpen(group)}
              onContextMenu={(event) => onGroupMenu(event, group)}
              onDragStart={(event) => handleProjectDragStart(event, group)}
              onDragOver={(event) => handleProjectDragOver(event, group)}
              onDrop={(event) => handleProjectDrop(event, group)}
              onDragEnd={clearDragState}
            />
          ))}

          {projects.length === 0 ? (
            <div className="projects-empty">
              <FolderPlus size={18} strokeWidth={1.7} />
              <p>还没有保存的项目</p>
            </div>
          ) : null}
        </div>

        {gitPanel}
      </div>

      <div className="sidebar-footer">
        <button type="button" className="add-project-btn" onClick={onAddProject}>
          <FolderPlus size={15} strokeWidth={1.8} />
          <span>添加项目</span>
        </button>
      </div>
    </aside>
  );
}
