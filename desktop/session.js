const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const VERSION = 1;
const MAX_TABS = 40;
const MAX_TAB_GROUPS = 30;
const TAB_GROUP_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
];

function filePath() {
  return path.join(app.getPath('userData'), 'session.json');
}

function emptySession() {
  return {
    version: VERSION,
    activeGroupKey: 'global',
    tabs: [],
    tabGroups: {},
    activeTabByGroup: {},
    sidebarCollapsed: false,
    rightIdsByGroup: {},
    rightActiveByGroup: {},
    focusSideByGroup: {},
    splitRatioByGroup: {},
    untitledContents: {},
    untitledDropped: [],
  };
}

// 空白窗口没有磁盘文件可读，内容只能跟着会话一起存。
// 限额按字符数（UTF-16 code unit）计，不是字节数：单个窗口 256K 字符、
// 总量 2M 字符。中文按 1 个字符算，实际落盘字节会更多，但会话文件仍很小。
// 超限的条目跳过——这里抛错会让整次会话保存失败，连页签都恢复不了。
// 被跳过的键单独记下来（untitledDropped）：只写内容会让恢复侧完全不知道
// 这个窗口存在，编号重排时可能把另一个窗口的内容顶到它的编号上。
const UNTITLED_MAX_CHARS = 256 * 1024;
const UNTITLED_TOTAL_MAX_CHARS = 2 * 1024 * 1024;

function normalizeUntitledContents(value) {
  if (!value || typeof value !== 'object') return { contents: {}, dropped: [] };
  const contents = {};
  const dropped = [];
  let total = 0;
  for (const [key, content] of Object.entries(value)) {
    if (typeof key !== 'string' || typeof content !== 'string') continue;
    if (content.length > UNTITLED_MAX_CHARS) {
      dropped.push(key);
      continue;
    }
    if (total + content.length > UNTITLED_TOTAL_MAX_CHARS) {
      dropped.push(key);
      continue;
    }
    contents[key] = content;
    total += content.length;
  }
  return { contents, dropped };
}

function normalizeDevice(value) {
  if (!value || typeof value !== 'object') return null;
  const width = Number(value.width);
  const height = Number(value.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const presetId = typeof value.presetId === 'string' ? value.presetId.slice(0, 40) : 'custom';
  return {
    presetId: presetId || 'custom',
    width: Math.round(Math.min(1920, Math.max(240, width))),
    height: Math.round(Math.min(2400, Math.max(320, height))),
    rotated: Boolean(value.rotated),
  };
}

function normalizeTab(value) {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' ? value.id : '';
  const groupKey = typeof value.groupKey === 'string' ? value.groupKey : '';
  const shellId = typeof value.shellId === 'string' ? value.shellId : '';
  if (!id || !groupKey || !shellId) return null;
  const descriptor = typeof value.descriptor === 'string' ? value.descriptor.trim().slice(0, 30) : '';
  return {
    id,
    groupKey,
    tabGroupId: typeof value.tabGroupId === 'string' ? value.tabGroupId.slice(0, 40) : '',
    shellId,
    seq: Math.max(1, Math.min(999, Number(value.seq) || 1)),
    paneNo: Math.max(0, Math.min(999, Number(value.paneNo) || 0)),
    descriptor,
    custom: Boolean(value.custom),
    cwd: typeof value.cwd === 'string' ? value.cwd : '',
    url: typeof value.url === 'string' ? value.url.trim().slice(0, 2000) : '',
    device: normalizeDevice(value.device),
    conversationId: typeof value.conversationId === 'string' ? value.conversationId.trim() : '',
    filePath: typeof value.filePath === 'string' ? value.filePath.trim().slice(0, 500) : '',
    diffChange:
      value.diffChange && typeof value.diffChange === 'object'
        ? {
            path: String(value.diffChange.path || '').slice(0, 500),
            origPath: String(value.diffChange.origPath || '').slice(0, 500),
            indexStatus: value.diffChange.indexStatus || null,
            worktreeStatus: value.diffChange.worktreeStatus || null,
          }
        : null,
    diffCommit:
      value.diffCommit && typeof value.diffCommit === 'object' && value.diffCommit.hash
        ? {
            hash: String(value.diffCommit.hash).slice(0, 40),
            short: String(value.diffCommit.short || '').slice(0, 40),
            subject: String(value.diffCommit.subject || '').slice(0, 200),
          }
        : null,
  };
}

function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object') return emptySession();
  const seen = new Set();
  const tabs = (Array.isArray(raw.tabs) ? raw.tabs : [])
    .map(normalizeTab)
    .filter((tab) => {
      if (!tab || seen.has(tab.id)) return false;
      seen.add(tab.id);
      return true;
    })
    .slice(0, MAX_TABS);
  const activeTabByGroup = {};
  if (raw.activeTabByGroup && typeof raw.activeTabByGroup === 'object') {
    for (const [groupKey, tabId] of Object.entries(raw.activeTabByGroup)) {
      if (typeof groupKey === 'string' && (typeof tabId === 'string' || tabId === null)) {
        activeTabByGroup[groupKey] = tabId;
      }
    }
  }
  const activeGroupKey =
    typeof raw.activeGroupKey === 'string' && raw.activeGroupKey
      ? raw.activeGroupKey
      : 'global';
  const rightIdsByGroup = {};
  if (raw.rightIdsByGroup && typeof raw.rightIdsByGroup === 'object') {
    for (const [groupKey, ids] of Object.entries(raw.rightIdsByGroup)) {
      if (typeof groupKey !== 'string' || !Array.isArray(ids)) continue;
      rightIdsByGroup[groupKey] = ids.filter((id) => typeof id === 'string' && id);
    }
  }
  const rightActiveByGroup = {};
  if (raw.rightActiveByGroup && typeof raw.rightActiveByGroup === 'object') {
    for (const [groupKey, tabId] of Object.entries(raw.rightActiveByGroup)) {
      if (typeof groupKey === 'string' && (typeof tabId === 'string' || tabId === null)) {
        rightActiveByGroup[groupKey] = tabId;
      }
    }
  }
  const focusSideByGroup = {};
  if (raw.focusSideByGroup && typeof raw.focusSideByGroup === 'object') {
    for (const [groupKey, side] of Object.entries(raw.focusSideByGroup)) {
      if (typeof groupKey === 'string' && (side === 'left' || side === 'right')) {
        focusSideByGroup[groupKey] = side;
      }
    }
  }
  const splitRatioByGroup = {};
  if (raw.splitRatioByGroup && typeof raw.splitRatioByGroup === 'object') {
    for (const [groupKey, ratio] of Object.entries(raw.splitRatioByGroup)) {
      const value = Number(ratio);
      if (typeof groupKey === 'string' && Number.isFinite(value)) {
        splitRatioByGroup[groupKey] = Math.min(0.78, Math.max(0.22, value));
      }
    }
  }

  // 组的成员关系由页签上的 tabGroupId 决定，没有成员的组直接丢掉
  const usedGroupIds = new Map();
  for (const tab of tabs) {
    if (!tab.tabGroupId) continue;
    let set = usedGroupIds.get(tab.groupKey);
    if (!set) {
      set = new Set();
      usedGroupIds.set(tab.groupKey, set);
    }
    set.add(tab.tabGroupId);
  }
  const tabGroups = {};
  if (raw.tabGroups && typeof raw.tabGroups === 'object') {
    for (const [groupKey, list] of Object.entries(raw.tabGroups)) {
      if (typeof groupKey !== 'string' || !Array.isArray(list)) continue;
      const used = usedGroupIds.get(groupKey);
      if (!used) continue;
      const seenIds = new Set();
      const groups = [];
      for (const value of list) {
        if (!value || typeof value !== 'object') continue;
        const id = typeof value.id === 'string' ? value.id.slice(0, 40) : '';
        if (!id || seenIds.has(id) || !used.has(id)) continue;
        seenIds.add(id);
        const name = typeof value.name === 'string' ? value.name.trim().slice(0, 30) : '';
        groups.push({
          id,
          name: name || '标签组',
          color: TAB_GROUP_COLORS.includes(value.color) ? value.color : 'grey',
          collapsed: Boolean(value.collapsed),
        });
        if (groups.length >= MAX_TAB_GROUPS) break;
      }
      if (groups.length) tabGroups[groupKey] = groups;
    }
  }

  // 指向不存在组的页签按未分组处理
  const knownGroupIds = new Map();
  for (const [groupKey, groups] of Object.entries(tabGroups)) {
    knownGroupIds.set(groupKey, new Set(groups.map((group) => group.id)));
  }
  for (const tab of tabs) {
    if (!tab.tabGroupId) continue;
    const known = knownGroupIds.get(tab.groupKey);
    if (!known || !known.has(tab.tabGroupId)) tab.tabGroupId = '';
  }

  const untitled = normalizeUntitledContents(raw.untitledContents);
  // 上一次保存记下的「超限未落盘」键要继续传给恢复侧一次：
  // 内容已经不在 untitledContents 里，只看内容会以为这个窗口从没存在过。
  // 恢复后窗口变成空窗口，下一次保存会自然把它清掉。
  const untitledDropped = new Set(untitled.dropped);
  if (Array.isArray(raw.untitledDropped)) {
    for (const key of raw.untitledDropped) {
      if (typeof key !== 'string') continue;
      if (Object.prototype.hasOwnProperty.call(untitled.contents, key)) continue;
      untitledDropped.add(key);
    }
  }

  return {
    version: VERSION,
    activeGroupKey,
    tabs,
    tabGroups,
    activeTabByGroup,
    sidebarCollapsed: Boolean(raw.sidebarCollapsed),
    rightIdsByGroup,
    rightActiveByGroup,
    splitRatioByGroup,
    focusSideByGroup,
    untitledContents: untitled.contents,
    untitledDropped: [...untitledDropped],
  };
}

function load() {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    return normalizeSession(JSON.parse(raw));
  } catch {
    return emptySession();
  }
}

function save(payload) {
  const data = normalizeSession(payload);
  const target = filePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, target);
  return data;
}

module.exports = { load, save, normalizeSession, emptySession };
