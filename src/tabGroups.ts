import type { Tab, TabGroup, TabGroupColor } from './types';

export const TAB_GROUP_COLORS: TabGroupColor[] = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
];

export const TAB_GROUP_COLOR_LABEL: Record<TabGroupColor, string> = {
  grey: '灰色',
  blue: '蓝色',
  red: '红色',
  yellow: '黄色',
  green: '绿色',
  pink: '粉色',
  purple: '紫色',
  cyan: '青色',
};

export const TAB_GROUP_NAME_LIMIT = 30;

export function isTabGroupColor(value: unknown): value is TabGroupColor {
  return typeof value === 'string' && (TAB_GROUP_COLORS as string[]).includes(value);
}

// 组的边界不落盘，由「连续且同组」的页签推导；tabGroupId 失效时按未分组处理
export type TabRun = {
  key: string;
  group: TabGroup | null;
  tabs: Tab[];
};

export function groupRuns(tabs: Tab[], groups: TabGroup[]): TabRun[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const runs: TabRun[] = [];
  for (const tab of tabs) {
    const group = tab.tabGroupId ? byId.get(tab.tabGroupId) ?? null : null;
    const last = runs[runs.length - 1];
    if (last && (last.group?.id ?? null) === (group?.id ?? null)) {
      last.tabs.push(tab);
      continue;
    }
    runs.push({ key: `${group?.id ?? 'solo'}:${tab.id}`, group, tabs: [tab] });
  }
  return runs;
}

export function nextTabGroupColor(groups: TabGroup[]): TabGroupColor {
  return TAB_GROUP_COLORS[groups.length % TAB_GROUP_COLORS.length];
}

export function lastTabOfGroup(tabs: Tab[], groupId: string): Tab | null {
  for (let index = tabs.length - 1; index >= 0; index -= 1) {
    if (tabs[index].tabGroupId === groupId) return tabs[index];
  }
  return null;
}

// 返回原数组的同一个引用表示没有变化，调用方据此避免多余的重渲染
export function setTabGroupMembership(
  tabs: Tab[],
  tabId: string,
  groupId: string | null,
): Tab[] {
  const target = tabs.find((tab) => tab.id === tabId);
  if (!target) return tabs;
  const current = target.tabGroupId ?? null;
  if (current === groupId) return tabs;
  return tabs.map((tab) => (tab.id === tabId ? { ...tab, tabGroupId: groupId } : tab));
}

// 新页签要贴着组放，否则组被拆成两段、渲染出两个组标题
export function insertTabIntoList(tabs: Tab[], tab: Tab, groupId: string | null): Tab[] {
  if (!groupId) return [...tabs, tab];
  const last = lastTabOfGroup(tabs, groupId);
  const index = last ? tabs.findIndex((item) => item.id === last.id) : -1;
  if (index < 0) return [...tabs, tab];
  const next = [...tabs];
  next.splice(index + 1, 0, tab);
  return next;
}

export function pruneTabGroups(
  groupsByProject: Record<string, TabGroup[]>,
  tabsByProject: Record<string, Tab[]>,
): Record<string, TabGroup[]> {
  let changed = false;
  const next: Record<string, TabGroup[]> = {};
  for (const [projectKey, groups] of Object.entries(groupsByProject)) {
    const used = new Set(
      (tabsByProject[projectKey] || [])
        .map((tab) => tab.tabGroupId)
        .filter((id): id is string => Boolean(id)),
    );
    const kept = groups.filter((group) => used.has(group.id));
    if (kept.length !== groups.length) changed = true;
    if (kept.length) next[projectKey] = kept;
  }
  return changed ? next : groupsByProject;
}
