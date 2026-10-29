import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  Code2,
  Command,
  Copy,
  CornerDownLeft,
  Cpu,
  Eraser,
  FileCode,
  FileDiff,
  Gem,
  FolderOpen,
  GitBranch,
  Globe,
  Link,
  Pencil,
  RotateCw,
  Sparkles,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import { moveById, nextPaneNo, toErrorMessage } from './lib';
import { accentFor, defaultTabTitle, GLOBAL_COLOR } from './theme';
import type { TerminalThemeMode } from './theme';
import { useGitStatus } from './gitStatus';
import { GLOBAL_GROUP_KEY, isBrowserTab, isDiffTab, isEditorTab, projectGroupKey } from './types';
import type {
  AppInfo,
  CommitRef,
  GitChange,
  GitPullStrategy,
  GitStatus,
  Group,
  HeadCommit,
  MenuEntry,
  MenuState,
  Project,
  StashEntry,
  SyncPrompt,
  Tab,
  UpdateCheckResult,
  UpdaterState,
} from './types';
import { discardSession, startPtyBus, subscribeAllData, subscribeExit } from './ptyBus';
import {
  classifyModelOutput,
  rollupModelStatus,
  type ModelStatus,
} from './sessionStatus';
import { TitleBar } from './components/TitleBar';
import { SettingsModal } from './components/SettingsModal';
import { readPrefs, readSeenVersion, writePrefs, writeSeenVersion } from './prefs';
import { Sidebar } from './components/Sidebar';
import { TAB_DRAG_TYPE, TabStrip } from './components/TabStrip';
import { EmptyState } from './components/EmptyState';
import { TerminalPane } from './components/TerminalPane';
import { BrowserPane } from './components/BrowserPane';
import { EditorPane } from './components/EditorPane';
import type { TerminalMenuActions } from './components/TerminalPane';
import { ProjectModal } from './components/ProjectModal';
import { RenameTabModal } from './components/RenameTabModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { PopupMenu } from './components/PopupMenu';
import { ToastViewport } from './components/Toast';
import type { ToastItem, ToastKind } from './components/Toast';
import { LogoMark } from './components/LogoMark';
import { GitPanel } from './components/GitPanel';
import type { SyncChoice } from './components/SyncDialog';
import { DiffPane } from './components/DiffPane';
import { AnnouncementModal } from './components/AnnouncementModal';
import type { Announcement } from './components/AnnouncementModal';

const ACTIVE_GROUP_STORAGE = 'cmd-toolbox.active-group';
const TERMINAL_THEME_STORAGE = 'cmd-toolbox.terminal-theme';
// 主进程侧有 5 分钟缓存，这里只是决定多久回填一次红点
const UPDATE_POLL_INTERVAL = 30 * 60 * 1000;

function readTerminalTheme(): TerminalThemeMode {
  return window.localStorage.getItem(TERMINAL_THEME_STORAGE) === 'light' ? 'light' : 'dark';
}

function shellIcon(shellId: string) {
  if (shellId === 'powershell') return <Command size={14} />;
  if (shellId === 'gitbash') return <GitBranch size={14} />;
  if (shellId === 'grok') return <Sparkles size={14} />;
  if (shellId === 'codex') return <Cpu size={14} />;
  if (shellId === 'claude') return <Bot size={14} />;
  if (shellId === 'gemini') return <Gem size={14} />;
  if (shellId === 'opencode') return <Code2 size={14} />;
  if (shellId === 'editor') return <FileCode size={14} />;
  if (shellId === 'diff') return <FileDiff size={14} />;
  if (shellId === 'browser') return <Globe size={14} />;
  return <SquareTerminal size={14} />;
}

function findLaunchTarget(info: AppInfo, id?: string) {
  const tools = info.tools || [];
  const all = [...info.shells, ...tools];
  return all.find((item) => item.id === (id || info.defaultShellId)) || info.shells[0];
}

function isCliTool(shellId: string) {
  return ['grok', 'codex', 'claude', 'gemini', 'opencode'].includes(shellId);
}

function BootScreen({ error }: { error?: string }) {
  return (
    <div className="boot-screen">
      <LogoMark size={36} />
      <div className="boot-title">Cmd Toolbox</div>
      {error ? (
        <>
          <div className="boot-error">
            <AlertTriangle size={14} />
            <span>{error}</span>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        </>
      ) : (
        <div className="boot-text">正在准备工作台…</div>
      )}
    </div>
  );
}

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [bootError, setBootError] = useState('');
  const [activeGroupKey, setActiveGroupKey] = useState(GLOBAL_GROUP_KEY);
  const [terminalThemeMode, setTerminalThemeMode] =
    useState<TerminalThemeMode>(readTerminalTheme);
  const [tabsByGroup, setTabsByGroup] = useState<Record<string, Tab[]>>({});
  const [activeTabByGroup, setActiveTabByGroup] = useState<Record<string, string | null>>({});
  const [focusTick, setFocusTick] = useState(0);
  const [modelStatusBySession, setModelStatusBySession] = useState<Record<string, ModelStatus>>(
    {},
  );
  const [projectModal, setProjectModal] = useState<{
    mode: 'add' | 'edit';
    project?: Project;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    groupKey: string;
    tabId: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [rightIdsByGroup, setRightIdsByGroup] = useState<Record<string, string[]>>({});
  const [rightActiveByGroup, setRightActiveByGroup] = useState<Record<string, string | null>>({});
  const [focusSideByGroup, setFocusSideByGroup] = useState<Record<string, 'left' | 'right'>>({});
  const [splitRatioByGroup, setSplitRatioByGroup] = useState<Record<string, number>>({});

  const tabsRef = useRef<Record<string, Tab[]>>({});
  const dirtyTabsRef = useRef<Map<string, boolean>>(new Map());
  const activeTabByGroupRef = useRef(activeTabByGroup);
  const sessionReadyRef = useRef(false);
  const sidebarCollapsedRef = useRef(false);
  const activeGroupKeyRef = useRef(activeGroupKey);
  activeGroupKeyRef.current = activeGroupKey;
  sidebarCollapsedRef.current = sidebarCollapsed;
  const rightIdsByGroupRef = useRef(rightIdsByGroup);
  const rightActiveByGroupRef = useRef(rightActiveByGroup);
  const focusSideByGroupRef = useRef(focusSideByGroup);
  rightIdsByGroupRef.current = rightIdsByGroup;
  rightActiveByGroupRef.current = rightActiveByGroup;
  focusSideByGroupRef.current = focusSideByGroup;
  const splitRatioByGroupRef = useRef(splitRatioByGroup);
  splitRatioByGroupRef.current = splitRatioByGroup;
  const splitDragRef = useRef({ x: 0, ratio: 0.5, width: 1 });
  const [splitDragging, setSplitDragging] = useState(false);

  // 分屏比例变化后延迟落盘：只靠关闭窗口时保存，异常退出会丢掉刚拖过的宽度
  useEffect(() => {
    if (!sessionReadyRef.current) return;
    const timer = window.setTimeout(() => {
      window.api.session?.save?.({
        activeGroupKey: activeGroupKeyRef.current,
        tabs: Object.values(tabsRef.current)
          .flat()
          .slice(0, 40)
          .map((tab) => ({
            id: tab.id,
            groupKey: tab.groupKey,
            shellId: tab.shellId,
            seq: tab.seq,
            paneNo: tab.paneNo,
            descriptor: tab.descriptor,
            custom: tab.custom,
            cwd: tab.cwd,
            url: tab.url || '',
            conversationId: tab.conversationId || '',
            filePath: tab.filePath || '',
            diffChange: tab.diffChange || null,
            diffCommit: tab.diffCommit || null,
          })),
        activeTabByGroup: activeTabByGroupRef.current,
        sidebarCollapsed: sidebarCollapsedRef.current,
        rightIdsByGroup: rightIdsByGroupRef.current,
        rightActiveByGroup: rightActiveByGroupRef.current,
        focusSideByGroup: focusSideByGroupRef.current,
        splitRatioByGroup: splitRatioByGroupRef.current,
      }).catch(() => {});
    }, 600);
    return () => window.clearTimeout(timer);
  }, [splitRatioByGroup, rightIdsByGroup]);

  const [prefs, setPrefs] = useState(readPrefs);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const outputBySessionRef = useRef<Record<string, string>>({});
  const idleTimersRef = useRef(new Map<string, number>());
  const toastIdRef = useRef(0);
  const toastTimersRef = useRef(new Map<number, number>());
  activeTabByGroupRef.current = activeTabByGroup;

  const pushToast = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = ++toastIdRef.current;
    setToasts((previous) => [...previous.slice(-2), { id, message, kind }]);
    const timer = window.setTimeout(
      () => {
        setToasts((previous) => previous.filter((item) => item.id !== id));
        toastTimersRef.current.delete(id);
      },
      kind === 'error' ? 4200 : 2400,
    );
    toastTimersRef.current.set(id, timer);
  }, []);

  useEffect(() => {
    return () => {
      toastTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      toastTimersRef.current.clear();
    };
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    const unsubscribe = subscribeAllData((sessionId, data) => {
      const tab = Object.values(tabsRef.current)
        .flat()
        .find((item) => item.sessionId === sessionId);
      if (!tab || !isCliTool(tab.shellId)) return;
      const combined = (outputBySessionRef.current[sessionId] || '') + data;
      outputBySessionRef.current[sessionId] =
        combined.length > 8000 ? combined.slice(-8000) : combined;
      const status = classifyModelOutput(outputBySessionRef.current[sessionId]);
      setModelStatusBySession((previous) =>
        previous[sessionId] === status ? previous : { ...previous, [sessionId]: status },
      );
      const timers = idleTimersRef.current;
      const pending = timers.get(sessionId);
      if (pending) window.clearTimeout(pending);
      if (status === 'waiting' || status === 'error') return;
      timers.set(
        sessionId,
        window.setTimeout(() => {
          setModelStatusBySession((previous) =>
            previous[sessionId] === 'idle' ? previous : { ...previous, [sessionId]: 'idle' },
          );
        }, 8000),
      );
    });
    return () => {
      unsubscribe();
      idleTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      idleTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const live = new Set(
      Object.values(tabsByGroup)
        .flat()
        .map((tab) => tab.sessionId),
    );
    setModelStatusBySession((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const sessionId of Object.keys(next)) {
        if (live.has(sessionId)) continue;
        delete next[sessionId];
        delete outputBySessionRef.current[sessionId];
        const timer = idleTimersRef.current.get(sessionId);
        if (timer) window.clearTimeout(timer);
        idleTimersRef.current.delete(sessionId);
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [tabsByGroup]);

  const applyTabs = useCallback((next: Record<string, Tab[]>) => {
    tabsRef.current = next;
    setTabsByGroup(next);
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const list = await window.api.projects.list();
      setProjects(list);
    } catch (error) {
      pushToast(toErrorMessage(error), 'error');
    }
  }, [pushToast]);

  useEffect(() => {
    let disposed = false;

    const unsubscribe = subscribeExit((sessionId, code) => {
      setModelStatusBySession((previous) => ({
        ...previous,
        [sessionId]: code === 0 ? 'idle' : 'error',
      }));
      setTabsByGroup((previous) => {
        let changed = false;
        const next: Record<string, Tab[]> = {};
        for (const [groupKey, list] of Object.entries(previous)) {
          next[groupKey] = list.map((tab) => {
            if (tab.sessionId !== sessionId) return tab;
            changed = true;
            return { ...tab, exited: true, exitCode: code };
          });
        }
        if (!changed) return previous;
        tabsRef.current = next;
        return next;
      });
    });

    void (async () => {
      try {
        if (!window.api) throw new Error('请通过 Cmd Toolbox 桌面应用打开');
        startPtyBus();
        await window.api.pty.resetAll();
        const [appInfo, projectList] = await Promise.all([
          window.api.getInfo(),
          window.api.projects.list(),
        ]);
        if (disposed) return;
        setInfo(appInfo);
        setProjects(projectList);

        const snapshot = await window.api.session.load();
        const groupByKey = new Map<string, { path: string; exists: boolean }>();
        groupByKey.set(GLOBAL_GROUP_KEY, { path: appInfo.homeDir, exists: true });
        for (const project of projectList) {
          groupByKey.set(projectGroupKey(project.id), {
            path: project.path,
            exists: project.exists,
          });
        }

        const restoredTabs: Record<string, Tab[]> = {};
        for (const saved of snapshot.tabs) {
          if (disposed) break;
          const group = groupByKey.get(saved.groupKey);
          if (!group || !group.exists) continue;
          const existing = restoredTabs[saved.groupKey] || [];
          const used = new Set(existing.map((item) => item.paneNo));
          let paneNo = Number(saved.paneNo) || 0;
          if (paneNo < 1 || used.has(paneNo)) {
            paneNo = nextPaneNo(existing.map((item) => item.paneNo));
          }

          if (saved.shellId === 'browser') {
            restoredTabs[saved.groupKey] = [
              ...existing,
              {
                id: saved.id,
                groupKey: saved.groupKey,
                sessionId: '',
                shellId: 'browser',
                seq: saved.seq || 1,
                paneNo,
                descriptor:
                  saved.custom && saved.descriptor ? saved.descriptor : '浏览器',
                custom: saved.custom,
                cwd: group.path,
                url: saved.url || 'about:blank',
                conversationId: '',
                exited: false,
              },
            ];
            continue;
          }

          if (
            saved.shellId === 'diff' &&
            ((saved.diffChange && saved.diffChange.path) || saved.diffCommit?.hash)
          ) {
            restoredTabs[saved.groupKey] = [
              ...existing,
              {
                id: saved.id,
                groupKey: saved.groupKey,
                sessionId: '',
                shellId: 'diff',
                seq: saved.seq || 1,
                paneNo,
                descriptor: saved.descriptor || '差异',
                custom: saved.custom,
                cwd: group.path,
                diffChange: saved.diffChange?.path ? saved.diffChange : undefined,
                diffCommit: saved.diffCommit?.hash ? saved.diffCommit : undefined,
                exited: false,
              },
            ];
            continue;
          }

          if (saved.shellId === 'editor') {
            restoredTabs[saved.groupKey] = [
              ...existing,
              {
                id: saved.id,
                groupKey: saved.groupKey,
                sessionId: '',
                shellId: 'editor',
                seq: saved.seq || 1,
                paneNo,
                descriptor: saved.descriptor || '编辑器',
                custom: saved.custom,
                cwd: group.path,
                filePath: saved.filePath || '',
                exited: false,
              },
            ];
            continue;
          }

          const shell = findLaunchTarget(appInfo, saved.shellId);
          if (!shell?.available) continue;
          try {
            const { id: sessionId } = await window.api.pty.create({
              groupKey: saved.groupKey,
              cwd: group.path,
              shellId: shell.id,
              cols: 100,
              rows: 30,
              resume: isCliTool(shell.id),
              resumeId: saved.conversationId || undefined,
            });
            const tab: Tab = {
              id: saved.id,
              groupKey: saved.groupKey,
              sessionId,
              shellId: shell.id,
              seq: saved.seq,
              paneNo,
              descriptor:
                saved.custom && saved.descriptor
                  ? saved.descriptor
                  : defaultTabTitle(shell.label),
              custom: saved.custom,
              cwd: group.path,
              conversationId: saved.conversationId || '',
              exited: false,
            };
            restoredTabs[saved.groupKey] = [...(restoredTabs[saved.groupKey] || []), tab];
          } catch (error) {
            pushToast(
              `恢复「${saved.descriptor || shell.label}」失败：${toErrorMessage(error)}`,
              'error',
            );
          }
        }

        if (disposed) {
          await window.api.pty.resetAll().catch(() => {});
          return;
        }

        applyTabs(restoredTabs);
        const restoredActive: Record<string, string | null> = {};
        for (const [groupKey, list] of Object.entries(restoredTabs)) {
          const wanted = snapshot.activeTabByGroup[groupKey];
          restoredActive[groupKey] =
            wanted && list.some((tab) => tab.id === wanted)
              ? wanted
              : list[list.length - 1]?.id ?? null;
        }
        setActiveTabByGroup(restoredActive);

        const savedGroup = snapshot.activeGroupKey || window.localStorage.getItem(ACTIVE_GROUP_STORAGE);
        if (
          savedGroup &&
          (savedGroup === GLOBAL_GROUP_KEY ||
            projectList.some((project) => projectGroupKey(project.id) === savedGroup))
        ) {
          setActiveGroupKey(savedGroup);
        }
        setSidebarCollapsed(Boolean(snapshot.sidebarCollapsed));
        const liveIds = new Set(Object.values(restoredTabs).flat().map((tab) => tab.id));
        const nextRightIds: Record<string, string[]> = {};
        for (const [groupKey, ids] of Object.entries(snapshot.rightIdsByGroup || {})) {
          const filtered = (ids || []).filter((id) => liveIds.has(id));
          if (filtered.length) nextRightIds[groupKey] = filtered;
        }
        setRightIdsByGroup(nextRightIds);
        const nextRightActive: Record<string, string | null> = {};
        for (const [groupKey, tabId] of Object.entries(snapshot.rightActiveByGroup || {})) {
          const ids = nextRightIds[groupKey] || [];
          nextRightActive[groupKey] =
            tabId && ids.includes(tabId) ? tabId : ids[ids.length - 1] ?? null;
        }
        setRightActiveByGroup(nextRightActive);
        const nextFocus: Record<string, 'left' | 'right'> = {};
        for (const [groupKey, side] of Object.entries(snapshot.focusSideByGroup || {})) {
          if (side === 'right' && (nextRightIds[groupKey] || []).length) nextFocus[groupKey] = 'right';
          else nextFocus[groupKey] = 'left';
        }
        setFocusSideByGroup(nextFocus);
        setSplitRatioByGroup(snapshot.splitRatioByGroup || {});
        sessionReadyRef.current = true;
      } catch (error) {
        sessionReadyRef.current = true;
        if (!disposed) setBootError(toErrorMessage(error));
      }
    })();

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const updateInitRef = useRef(false);

  // startup 弹公告，manual 只回填设置面板，background 只刷新红点，都不打扰用户
  const runUpdateCheck = useCallback(async (mode: 'startup' | 'manual' | 'background') => {
    // 浏览器里打开的预览没有 preload 桥，直接跳过
    const bridge = window.api?.updates;
    if (!bridge) return;
    const seen = readSeenVersion();
    if (mode !== 'background') setUpdateBusy(true);
    try {
      const result = await bridge.check(seen);
      if (!result.ok) {
        // 后台轮询失败时保留上一次结果，否则红点会莫名其妙消失
        if (mode !== 'background') setUpdateCheck(result);
        return;
      }
      setUpdateCheck(result);
      // 首次启用这个功能：只记下当前版本，不打扰用户
      if (seen === null) {
        writeSeenVersion(result.current);
        return;
      }
      if (mode !== 'startup' || !result.announce) return;
      setAnnouncement({
        kind: result.announce,
        version: result.announce === 'available' ? result.latest || result.current : result.current,
        notes: result.notes,
        url: result.url,
      });
    } catch (error) {
      if (mode !== 'background') {
        setUpdateCheck({ ok: false, message: toErrorMessage(error) });
      }
    } finally {
      if (mode !== 'background') setUpdateBusy(false);
    }
  }, []);

  useEffect(() => {
    // 只自动检查一次：会话恢复完成后再请求，避免和首屏抢网络
    if (updateInitRef.current || !info) return;
    updateInitRef.current = true;
    void runUpdateCheck('startup');
  }, [info, runUpdateCheck]);

  useEffect(() => {
    // 长时间开着也能发现新版本；命中主进程 5 分钟缓存，不会真的频繁打 GitHub
    if (!info) return;
    const timer = window.setInterval(() => {
      void runUpdateCheck('background');
    }, UPDATE_POLL_INTERVAL);
    return () => window.clearInterval(timer);
  }, [info, runUpdateCheck]);

  const [updater, setUpdater] = useState<UpdaterState>({
    phase: 'idle',
    percent: 0,
    version: '',
    message: '',
  });

  useEffect(() => {
    const bridge = window.api?.updater;
    if (!bridge) return;
    const unsubscribe = bridge.onEvent(setUpdater);
    // 重挂载时补一次当前状态，否则下载进度会丢
    void bridge.state().then(setUpdater).catch(() => {});
    return unsubscribe;
  }, []);

  const startUpdate = useCallback(async () => {
    const bridge = window.api?.updater;
    if (!bridge) return;
    try {
      const result = await bridge.download();
      if (!result.ok) pushToast(result.message, 'error');
    } catch (error) {
      pushToast(toErrorMessage(error), 'error');
    }
  }, [pushToast]);

  const installUpdate = useCallback(async () => {
    const bridge = window.api?.updater;
    if (!bridge) return;
    try {
      const result = await bridge.install();
      if (!result.ok) pushToast(result.message, 'error');
    } catch (error) {
      pushToast(toErrorMessage(error), 'error');
    }
  }, [pushToast]);

  const groups = useMemo<Group[]>(() => {
    if (!info) return [];
    return [
      {
        key: GLOBAL_GROUP_KEY,
        kind: 'global',
        name: '全局终端',
        path: info.homeDir,
        exists: true,
        color: GLOBAL_COLOR,
      },
      ...projects.map((project) => ({
        key: projectGroupKey(project.id),
        kind: 'project' as const,
        projectId: project.id,
        name: project.name,
        path: project.path,
        exists: project.exists,
        color: accentFor(project.id),
      })),
    ];
  }, [info, projects]);

  const groupsByKey = useMemo(() => new Map(groups.map((group) => [group.key, group])), [groups]);

  const activeGroup = groups.find((group) => group.key === activeGroupKey) ?? groups[0] ?? null;

  const gitGroup =
    activeGroup && activeGroup.kind === 'project' && activeGroup.exists ? activeGroup : null;
  const gitGroupRef = useRef<Group | null>(gitGroup);
  gitGroupRef.current = gitGroup;

  const {
    status: gitStatus,
    refreshing: gitRefreshing,
    refresh: refreshGit,
  } = useGitStatus(gitGroup, {
    isSessionActive: (sessionId) => {
      const key = activeGroupKeyRef.current;
      return (tabsRef.current[key] || []).some((tab) => tab.sessionId === sessionId);
    },
  });

  const [gitBranches, setGitBranches] = useState<{ current: string; list: string[] }>({
    current: '',
    list: [],
  });
  const [branchBusy, setBranchBusy] = useState(false);
  const [gitCommits, setGitCommits] = useState<
    Array<{ hash: string; short: string; author: string; when: string; subject: string }>
  >([]);

  useEffect(() => {
    const group = gitGroupRef.current;
    if (!group) {
      setGitCommits([]);
      return;
    }
    let cancelled = false;
    void window.api.git
      .log(group.path, 20)
      .then((result) => {
        if (!cancelled) setGitCommits(result.commits);
      })
      .catch(() => {
        if (!cancelled) setGitCommits([]);
      });
    return () => {
      cancelled = true;
    };
  }, [gitStatus]);

  const [headCommit, setHeadCommit] = useState<HeadCommit | null>(null);

  // 切项目时先清空，避免新项目的面板在 head 刷新前沿用上一个项目的提交信息
  const gitGroupKey = gitGroup?.key ?? null;
  useEffect(() => {
    setHeadCommit(null);
  }, [gitGroupKey]);

  useEffect(() => {
    const group = gitGroupRef.current;
    if (!group) {
      setHeadCommit(null);
      return;
    }
    let cancelled = false;
    void window.api.git
      .headCommit(group.path)
      .then((result) => {
        if (!cancelled) setHeadCommit(result);
      })
      .catch(() => {
        if (!cancelled) setHeadCommit(null);
      });
    return () => {
      cancelled = true;
    };
  }, [gitStatus]);

  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [stashBusy, setStashBusy] = useState<string | null>(null);

  useEffect(() => {
    const group = gitGroupRef.current;
    if (!group) {
      setStashes([]);
      return;
    }
    let cancelled = false;
    void window.api.git
      .stashList(group.path)
      .then((result) => {
        if (!cancelled) setStashes(result.stashes);
      })
      .catch(() => {
        if (!cancelled) setStashes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [gitStatus]);

  useEffect(() => {
    const group = gitGroupRef.current;
    if (!group) {
      setGitBranches({ current: '', list: [] });
      return;
    }
    let cancelled = false;
    void window.api.git
      .branches(group.path)
      .then((result) => {
        if (!cancelled) setGitBranches(result);
      })
      .catch(() => {
        if (!cancelled) setGitBranches({ current: '', list: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [gitStatus]);

  const gitCommit = useCallback(
    async (message: string) => {
      const group = gitGroupRef.current;
      if (!group) return false;
      try {
        const result = await window.api.git.commit(group.path, message);
        pushToast(`已提交 ${result.commit}`, 'success');
        await refreshGit();
        return true;
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
        return false;
      }
    },
    [pushToast, refreshGit],
  );

  const gitUndoCommit = useCallback(async (): Promise<string | null> => {
    const group = gitGroupRef.current;
    if (!group) return null;
    try {
      const result = await window.api.git.undoCommit(group.path);
      pushToast('已撤销提交，改动回到暂存区', 'success');
      await refreshGit();
      return result.message;
    } catch (error) {
      pushToast(toErrorMessage(error), 'error');
      return null;
    }
  }, [pushToast, refreshGit]);

  const gitAmend = useCallback(
    async (message: string) => {
      const group = gitGroupRef.current;
      if (!group) return false;
      try {
        const result = await window.api.git.amend(group.path, message);
        pushToast(`已修改提交 ${result.commit}`, 'success');
        await refreshGit();
        return true;
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
        return false;
      }
    },
    [pushToast, refreshGit],
  );

  // 撤销 / 修改提交打开弹窗前强制拉一次真实 HEAD，不用可能滞后的缓存
  const gitRefreshHead = useCallback(async (): Promise<HeadCommit | null> => {
    const group = gitGroupRef.current;
    if (!group) return null;
    try {
      const fresh = await window.api.git.headCommit(group.path);
      setHeadCommit(fresh);
      if (!fresh) pushToast('还没有提交可以操作', 'error');
      return fresh;
    } catch (error) {
      setHeadCommit(null);
      pushToast(toErrorMessage(error), 'error');
      return null;
    }
  }, [pushToast]);

  const gitStashSave = useCallback(async () => {
    const group = gitGroupRef.current;
    if (!group) return false;
    try {
      await window.api.git.stashSave(group.path);
      pushToast('改动已收起', 'success');
      await refreshGit();
      return true;
    } catch (error) {
      pushToast(toErrorMessage(error), 'error');
      return false;
    }
  }, [pushToast, refreshGit]);

  const gitStashPop = useCallback(
    async (ref: string) => {
      const group = gitGroupRef.current;
      if (!group) return false;
      setStashBusy(ref);
      try {
        const result = await window.api.git.stashPop(group.path, ref);
        if (result.conflicts.length) {
          pushToast(`恢复后有 ${result.conflicts.length} 处冲突，stash 记录已保留`, 'error');
        } else {
          pushToast('已恢复收起的改动', 'success');
        }
        await refreshGit();
        return true;
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
        return false;
      } finally {
        setStashBusy(null);
      }
    },
    [pushToast, refreshGit],
  );

  const gitStashDrop = useCallback(
    async (ref: string) => {
      const group = gitGroupRef.current;
      if (!group) return false;
      setStashBusy(ref);
      try {
        await window.api.git.stashDrop(group.path, ref);
        pushToast('已丢弃 stash 记录', 'success');
        await refreshGit();
        return true;
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
        return false;
      } finally {
        setStashBusy(null);
      }
    },
    [pushToast, refreshGit],
  );

  const [syncPrompt, setSyncPrompt] = useState<SyncPrompt | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [pullBusy, setPullBusy] = useState(false);

  // 弹窗绑定的是一次性的项目状态，切走项目后必须关掉，避免对着另一个仓库执行拉取
  useEffect(() => {
    setSyncPrompt(null);
  }, [gitGroup?.key]);

  const gitPush = useCallback(
    async (options: { force?: boolean } = {}) => {
      const group = gitGroupRef.current;
      if (!group) return false;
      try {
        const result = await window.api.git.push(group.path, options);
        if (!result.ok) {
          pushToast(result.message, 'error');
          // 被拒绝时给出和 VSCode 一样的三种处理方式，而不是让用户自己开终端
          if (result.reason === 'rejected') {
            setSyncPrompt({ kind: 'push-rejected', message: result.message });
          }
          await refreshGit();
          return false;
        }
        pushToast(`已推送到 ${result.upstream}`, 'success');
        await refreshGit();
        return true;
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
        // 推送失败后刷新，让「拉取」按钮及时出现（线上有新提交时）
        await refreshGit();
        return false;
      }
    },
    [pushToast, refreshGit],
  );

  const gitPull = useCallback(
    async (strategy: GitPullStrategy = 'ff'): Promise<GitStatus | null> => {
      const group = gitGroupRef.current;
      if (!group) return null;
      setPullBusy(true);
      try {
        const result = await window.api.git.pull(group.path, { strategy });
        if (!result.ok) {
          await refreshGit();
          if (result.reason === 'diverged' || result.reason === 'multiple-branches') {
            setSyncPrompt({ kind: result.reason, message: result.message });
          } else {
            // 冲突不再弹窗：关掉它，冲突文件由刷新后的左侧列表标出
            setSyncPrompt(null);
            pushToast(result.message, 'error');
          }
          return null;
        }
        pushToast('已拉取到最新代码', 'success');
        return await refreshGit();
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
        await refreshGit();
        return null;
      } finally {
        setPullBusy(false);
      }
    },
    [pushToast, refreshGit],
  );

  // 拉取成功后只有本地确实有提交才继续推送，避免空推和误导性的「已推送」提示
  const pullThenPush = useCallback(
    async (strategy: GitPullStrategy) => {
      const next = await gitPull(strategy);
      if (!next) return;
      setSyncPrompt(null);
      if (next.ok && next.ahead > 0) await gitPush();
    },
    [gitPull, gitPush],
  );

  const runSyncChoice = useCallback(
    async (choice: SyncChoice) => {
      const prompt = syncPrompt;
      const group = gitGroupRef.current;
      if (!prompt || !group) return;
      setSyncBusy(true);
      try {
        if (choice === 'force') {
          if (await gitPush({ force: true })) setSyncPrompt(null);
          return;
        }
        if (choice === 'repair') {
          try {
            const fixed = await window.api.git.repairUpstream(group.path);
            pushToast(
              fixed.changed ? `已修复分支「${fixed.branch}」的上游配置` : '上游配置无需修复',
              'success',
            );
          } catch (error) {
            pushToast(toErrorMessage(error), 'error');
            return;
          }
          await pullThenPush('ff');
          return;
        }

        await pullThenPush(choice);
      } finally {
        setSyncBusy(false);
      }
    },
    [gitPush, pullThenPush, pushToast, syncPrompt],
  );

  const gitInit = useCallback(async () => {
    const group = gitGroupRef.current;
    if (!group) return false;
    try {
      await window.api.git.init(group.path);
      pushToast('已初始化 Git 仓库', 'success');
      await refreshGit();
      return true;
    } catch (error) {
      pushToast(toErrorMessage(error), 'error');
      return false;
    }
  }, [pushToast, refreshGit]);

  const withGitGroup = useCallback(
    async (action: (path: string) => Promise<unknown>, successMessage = '') => {
      const group = gitGroupRef.current;
      if (!group) return false;
      try {
        await action(group.path);
        if (successMessage) pushToast(successMessage, 'success');
        return true;
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
        return false;
      } finally {
        // 即使动作中途失败也要刷新，避免面板继续显示已经被处理的改动
        await refreshGit();
      }
    },
    [pushToast, refreshGit],
  );

  const gitStage = useCallback(
    (paths: string[]) => withGitGroup((path) => window.api.git.stage(path, paths)),
    [withGitGroup],
  );

  const gitUnstage = useCallback(
    (paths: string[]) => withGitGroup((path) => window.api.git.unstage(path, paths)),
    [withGitGroup],
  );

  const gitDiscard = useCallback(
    (payload: { tracked: string[]; untracked: string[] }) =>
      withGitGroup((path) => window.api.git.discard(path, payload), '已放弃修改'),
    [withGitGroup],
  );

  const gitStageAll = useCallback(
    () => withGitGroup((path) => window.api.git.stageAll(path)),
    [withGitGroup],
  );

  const gitDiscardAll = useCallback(
    () => withGitGroup((path) => window.api.git.discardAll(path), '已放弃全部修改'),
    [withGitGroup],
  );

  const gitCheckout = useCallback(
    async (branch: string) => {
      const group = gitGroupRef.current;
      if (!group) return;
      setBranchBusy(true);
      try {
        // 读最新状态：编辑器保存等操作不会触发 gitStatus 刷新
        const fresh = await window.api.git.status(group.path);
        const dirty = Boolean(
          fresh.ok && (fresh.stagedCount > 0 || fresh.unstagedCount > 0),
        );
        if (dirty) {
          pushToast('有未提交的改动，请先提交或放弃后再切换分支', 'error');
          return;
        }
        await window.api.git.checkout(group.path, branch);
        pushToast(`已切换到 ${branch}`, 'success');
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
      } finally {
        await refreshGit();
        setBranchBusy(false);
      }
    },
    [pushToast, refreshGit],
  );

  const gitCreateBranch = useCallback(
    async (name: string, startPoint: string) => {
      const group = gitGroupRef.current;
      if (!group) return;
      setBranchBusy(true);
      try {
        const fresh = await window.api.git.status(group.path);
        const dirty = Boolean(
          fresh.ok && (fresh.stagedCount > 0 || fresh.unstagedCount > 0),
        );
        if (dirty) {
          pushToast('有未提交的改动，请先提交或放弃后再新建分支', 'error');
          return;
        }
        await window.api.git.createBranch(group.path, name, startPoint);
        pushToast(`已创建并切换到 ${name}`, 'success');
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
      } finally {
        await refreshGit();
        setBranchBusy(false);
      }
    },
    [pushToast, refreshGit],
  );

  const gitMerge = useCallback(
    async (branch: string) => {
      const group = gitGroupRef.current;
      if (!group) return;
      setBranchBusy(true);
      try {
        const result = await window.api.git.merge(group.path, branch);
        if (result.conflicted.length > 0) {
          pushToast(`合并 ${branch} 时发生冲突，请在更改列表中解决冲突`, 'error');
        } else {
          pushToast(`已合并 ${branch}`, 'success');
        }
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
      } finally {
        await refreshGit();
        setBranchBusy(false);
      }
    },
    [pushToast, refreshGit],
  );

  const gitMergeInto = useCallback(
    async (source: string, target: string) => {
      const group = gitGroupRef.current;
      if (!group) return;
      setBranchBusy(true);
      try {
        const result = await window.api.git.mergeInto(group.path, source, target);
        if (result.conflicted.length > 0) {
          pushToast(
            `合并 ${source} 到 ${target} 时发生冲突，请在更改列表中解决冲突`,
            'error',
          );
        } else if (result.returnedTo) {
          pushToast(`已把 ${source} 合并到 ${target}，已切回 ${result.returnedTo}`, 'success');
        } else {
          pushToast(`已把 ${source} 合并到 ${target}`, 'success');
        }
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
      } finally {
        await refreshGit();
        setBranchBusy(false);
      }
    },
    [pushToast, refreshGit],
  );

  const activeTabs = activeGroup ? tabsByGroup[activeGroup.key] || [] : [];
  const rightIds = activeGroup ? rightIdsByGroup[activeGroup.key] || [] : [];
  const split = rightIds.length > 0;
  const leftTabs = activeTabs.filter((tab) => !rightIds.includes(tab.id));
  const storedLeftId = activeGroup ? activeTabByGroup[activeGroup.key] ?? null : null;
  const activeTab =
    leftTabs.find((tab) => tab.id === storedLeftId) ?? leftTabs[leftTabs.length - 1] ?? null;
  const effectiveActiveTabId = activeTab?.id ?? null;
  const rightActiveId = activeGroup ? rightActiveByGroup[activeGroup.key] ?? null : null;
  const rightTab =
    !activeGroup || rightIds.length === 0
      ? null
      : activeTabs.find((tab) => tab.id === rightActiveId) ??
        activeTabs.find((tab) => rightIds.includes(tab.id)) ??
        null;
  const effectiveRightTabId = rightTab?.id ?? null;
  const focusSide = activeGroup ? focusSideByGroup[activeGroup.key] || 'left' : 'left';
  const splitRatio = activeGroup ? splitRatioByGroup[activeGroup.key] ?? 0.5 : 0.5;
  const rightTabs = rightIds
    .map((id) => activeTabs.find((tab) => tab.id === id))
    .filter((tab): tab is Tab => Boolean(tab));
  const allTabs = useMemo(() => Object.values(tabsByGroup).flat(), [tabsByGroup]);
  const counts = useMemo(() => {
    const next: Record<string, number> = {};
    for (const [groupKey, list] of Object.entries(tabsByGroup)) next[groupKey] = list.length;
    return next;
  }, [tabsByGroup]);

  const modelStatusByGroup = useMemo(() => {
    const next: Record<string, ModelStatus> = {};
    for (const [groupKey, list] of Object.entries(tabsByGroup)) {
      const values = list
        .filter((tab) => isCliTool(tab.shellId))
        .map((tab) => {
          if (tab.exited && tab.exitCode) return 'error' as const;
          return modelStatusBySession[tab.sessionId] || 'idle';
        });
      next[groupKey] = rollupModelStatus(values);
    }
    return next;
  }, [modelStatusBySession, tabsByGroup]);

  useEffect(() => {
    if (!info) return;
    if (groups.length > 0 && !groups.some((group) => group.key === activeGroupKey)) {
      setActiveGroupKey(GLOBAL_GROUP_KEY);
    }
  }, [groups, info, activeGroupKey]);

  useEffect(() => {
    if (!info) return;
    window.localStorage.setItem(ACTIVE_GROUP_STORAGE, activeGroupKey);
  }, [activeGroupKey, info]);

  useEffect(() => {
    const flushSession = () => {
      if (!sessionReadyRef.current || !window.api?.session?.saveSync) return;
      const tabs = Object.values(tabsRef.current)
        .flat()
        .slice(0, 40)
        .map((tab) => ({
          id: tab.id,
          groupKey: tab.groupKey,
          shellId: tab.shellId,
          seq: tab.seq,
          descriptor: tab.descriptor,
          custom: tab.custom,
          cwd: tab.cwd,
          conversationId: tab.conversationId || '',
          filePath: tab.filePath || '',
          diffChange: tab.diffChange || null,
          diffCommit: tab.diffCommit || null,
          paneNo: tab.paneNo,
          url: tab.url || '',
        }));
      window.api.session.saveSync({
        activeGroupKey: activeGroupKeyRef.current,
        tabs,
        activeTabByGroup: activeTabByGroupRef.current,
        sidebarCollapsed: sidebarCollapsedRef.current,
        rightIdsByGroup: rightIdsByGroupRef.current,
        rightActiveByGroup: rightActiveByGroupRef.current,
        focusSideByGroup: focusSideByGroupRef.current,
        splitRatioByGroup: splitRatioByGroupRef.current,
      });
    };
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flushSession();
    };
    window.addEventListener('beforeunload', flushSession);
    document.addEventListener('visibilitychange', onHidden);
    const unsubscribeQuit = window.api.onWillQuit ? window.api.onWillQuit(flushSession) : () => {};
    return () => {
      window.removeEventListener('beforeunload', flushSession);
      document.removeEventListener('visibilitychange', onHidden);
      unsubscribeQuit();
    };
  }, []);

  useEffect(() => {
    if (!info || !sessionReadyRef.current) return;
    const timer = window.setTimeout(() => {
      const tabs = Object.values(tabsByGroup)
        .flat()
        .slice(0, 40)
        .map((tab) => ({
          id: tab.id,
          groupKey: tab.groupKey,
          shellId: tab.shellId,
          seq: tab.seq,
          descriptor: tab.descriptor,
          custom: tab.custom,
          cwd: tab.cwd,
          conversationId: tab.conversationId || '',
          filePath: tab.filePath || '',
          paneNo: tab.paneNo,
          url: tab.url || '',
        }));
      void window.api.session
        .save({
          activeGroupKey,
          tabs,
          activeTabByGroup,
          sidebarCollapsed,
          rightIdsByGroup,
          rightActiveByGroup,
          focusSideByGroup,
          splitRatioByGroup,
        })
        .catch((error) => pushToast(toErrorMessage(error), 'error'));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [
    activeGroupKey,
    activeTabByGroup,
    focusSideByGroup,
    info,
    pushToast,
    rightActiveByGroup,
    rightIdsByGroup,
    sidebarCollapsed,
    splitRatioByGroup,
    tabsByGroup,
  ]);

  useEffect(() => {
    window.localStorage.setItem(TERMINAL_THEME_STORAGE, terminalThemeMode);
  }, [terminalThemeMode]);

  useEffect(() => {
    document.title = activeGroup ? `${activeGroup.name} · Cmd Toolbox` : 'Cmd Toolbox';
  }, [activeGroup]);

  useEffect(() => {
    if (!window.api?.panes) return;
    const panes = Object.values(tabsByGroup).flat().map((tab) => {
      const group = groupsByKey.get(tab.groupKey);
      return {
        id: tab.id,
        paneNo: tab.paneNo,
        kind: isBrowserTab(tab) ? 'browser' : isEditorTab(tab) ? 'editor' : 'terminal',
        shellId: tab.shellId,
        descriptor: tab.descriptor,
        url: tab.url || '',
        filePath: tab.filePath || '',
        cwd: tab.cwd,
        groupKey: tab.groupKey,
        groupName: group?.name || '',
        sessionId: tab.sessionId,
        exited: tab.exited,
      };
    });
    window.api.panes.sync(panes);
  }, [groupsByKey, tabsByGroup]);

  const createBrowser = useCallback(
    (group: Group) => {
      if (!group.exists) {
        pushToast('项目目录不存在，请先编辑项目路径', 'error');
        return;
      }
      const groupTabs = tabsRef.current[group.key] || [];
      const tab: Tab = {
        id: crypto.randomUUID(),
        groupKey: group.key,
        sessionId: '',
        shellId: 'browser',
        seq: 1,
        paneNo: nextPaneNo(groupTabs.map((item) => item.paneNo)),
        descriptor: '浏览器',
        custom: false,
        cwd: group.path,
        url: 'about:blank',
        exited: false,
      };
      applyTabs({ ...tabsRef.current, [group.key]: [...groupTabs, tab] });
      setActiveGroupKey(group.key);
      const onRight =
        (focusSideByGroupRef.current[group.key] || 'left') === 'right' &&
        (rightIdsByGroupRef.current[group.key] || []).length > 0;
      if (onRight) {
        setRightIdsByGroup((previous) => ({
          ...previous,
          [group.key]: [...(previous[group.key] || []), tab.id],
        }));
        setRightActiveByGroup((previous) => ({ ...previous, [group.key]: tab.id }));
      } else {
        setActiveTabByGroup((previous) => ({ ...previous, [group.key]: tab.id }));
      }
    },
    [applyTabs, pushToast],
  );

  const setTabDescriptor = useCallback(
    (groupKey: string, tabId: string, descriptor: string) => {
      const existing = (tabsRef.current[groupKey] || []).find((item) => item.id === tabId);
      // 值未变化时直接返回：即使回调身份每次都变，也不会制造新的 tabs 对象和渲染循环
      if (!existing || (existing.custom && existing.descriptor === descriptor)) return;
      applyTabs({
        ...tabsRef.current,
        [groupKey]: (tabsRef.current[groupKey] || []).map((item) =>
          item.id === tabId ? { ...item, descriptor, custom: true } : item,
        ),
      });
    },
    [applyTabs],
  );

  const handleDirtyChange = useCallback((tabId: string, dirty: boolean) => {
    if (dirty) dirtyTabsRef.current.set(tabId, true);
    else dirtyTabsRef.current.delete(tabId);
  }, []);

  const createEditor = useCallback(
    (group: Group, filePath = '') => {
      if (!group.exists) {
        pushToast('项目目录不存在，请先编辑项目路径', 'error');
        return;
      }
      const groupTabs = tabsRef.current[group.key] || [];
      const tab: Tab = {
        id: crypto.randomUUID(),
        groupKey: group.key,
        sessionId: '',
        shellId: 'editor',
        seq: 1,
        paneNo: nextPaneNo(groupTabs.map((item) => item.paneNo)),
        descriptor: '编辑器',
        custom: false,
        cwd: group.path,
        filePath,
        exited: false,
      };
      applyTabs({ ...tabsRef.current, [group.key]: [...groupTabs, tab] });
      setActiveGroupKey(group.key);
      setActiveTabByGroup((previous) => ({ ...previous, [group.key]: tab.id }));
    },
    [applyTabs, pushToast],
  );

  const openDiffTab = useCallback(
    (group: Group, change: GitChange) => {
      if (!group.exists) {
        pushToast('项目目录不存在，请先编辑项目路径', 'error');
        return;
      }
      const groupTabs = tabsRef.current[group.key] || [];
      const existing = groupTabs.find(
        (item) => item.shellId === 'diff' && item.diffChange?.path === change.path,
      );
      if (existing) {
        setActiveGroupKey(group.key);
        setActiveTabByGroup((previous) => ({ ...previous, [group.key]: existing.id }));
        return;
      }
      const tab: Tab = {
        id: crypto.randomUUID(),
        groupKey: group.key,
        sessionId: '',
        shellId: 'diff',
        seq: 1,
        paneNo: nextPaneNo(groupTabs.map((item) => item.paneNo)),
        descriptor: change.path.split('/').pop() || '差异',
        custom: true,
        cwd: group.path,
        diffChange: change,
        exited: false,
      };
      applyTabs({ ...tabsRef.current, [group.key]: [...groupTabs, tab] });
      setActiveGroupKey(group.key);
      setActiveTabByGroup((previous) => ({ ...previous, [group.key]: tab.id }));
    },
    [applyTabs, pushToast],
  );

  const openCommitDiffTab = useCallback(
    (group: Group, commit: CommitRef) => {
      if (!group.exists) {
        pushToast('项目目录不存在，请先编辑项目路径', 'error');
        return;
      }
      const groupTabs = tabsRef.current[group.key] || [];
      const existing = groupTabs.find(
        (item) => item.shellId === 'diff' && item.diffCommit?.hash === commit.hash,
      );
      if (existing) {
        setActiveGroupKey(group.key);
        setActiveTabByGroup((previous) => ({ ...previous, [group.key]: existing.id }));
        return;
      }
      const tab: Tab = {
        id: crypto.randomUUID(),
        groupKey: group.key,
        sessionId: '',
        shellId: 'diff',
        seq: 1,
        paneNo: nextPaneNo(groupTabs.map((item) => item.paneNo)),
        descriptor: commit.short,
        custom: true,
        cwd: group.path,
        diffCommit: commit,
        exited: false,
      };
      applyTabs({ ...tabsRef.current, [group.key]: [...groupTabs, tab] });
      setActiveGroupKey(group.key);
      setActiveTabByGroup((previous) => ({ ...previous, [group.key]: tab.id }));
    },
    [applyTabs, pushToast],
  );

  const openEditorFile = useCallback(
    (group: Group, relPath: string) => {
      const existing = (tabsRef.current[group.key] || []).find(
        (item) => item.shellId === 'editor' && item.filePath === relPath,
      );
      if (existing) {
        setActiveTabByGroup((previous) => ({ ...previous, [group.key]: existing.id }));
        setActiveGroupKey(group.key);
        return;
      }
      createEditor(group, relPath);
    },
    [createEditor],
  );

  const createTerminal = useCallback(
    async (group: Group, shellId?: string): Promise<Tab | null> => {
      if (!info) return null;
      if (shellId === 'browser') {
        createBrowser(group);
        return null;
      }
      const shell = findLaunchTarget(info, shellId);
      if (!shell) {
        pushToast('当前系统没有可用的终端类型', 'error');
        return null;
      }
      if (!shell.available) {
        pushToast(shell.hint || `未安装 ${shell.label}，装好后重启 Cmd Toolbox`, 'error');
        return null;
      }
      if (!group.exists) {
        pushToast('项目目录不存在，请先编辑项目路径', 'error');
        return null;
      }

      try {
        const { id: sessionId } = await window.api.pty.create({
          groupKey: group.key,
          cwd: group.path,
          shellId: shell.id,
          cols: 100,
          rows: 30,
        });

        const groupTabs = tabsRef.current[group.key] || [];
        const seq =
          groupTabs
            .filter((tab) => tab.shellId === shell.id)
            .reduce((maximum, tab) => Math.max(maximum, tab.seq), 0) + 1;
        const tab: Tab = {
          id: crypto.randomUUID(),
          groupKey: group.key,
          sessionId,
          shellId: shell.id,
          seq,
          paneNo: nextPaneNo(groupTabs.map((item) => item.paneNo)),
          descriptor: defaultTabTitle(shell.label),
          custom: false,
          cwd: group.path,
          exited: false,
        };

        applyTabs({ ...tabsRef.current, [group.key]: [...groupTabs, tab] });
        setActiveGroupKey(group.key);
        const onRight =
          (focusSideByGroupRef.current[group.key] || 'left') === 'right' &&
          (rightIdsByGroupRef.current[group.key] || []).length > 0;
        if (onRight) {
          setRightIdsByGroup((previous) => ({
            ...previous,
            [group.key]: [...(previous[group.key] || []), tab.id],
          }));
          setRightActiveByGroup((previous) => ({ ...previous, [group.key]: tab.id }));
        } else {
          setActiveTabByGroup((previous) => ({ ...previous, [group.key]: tab.id }));
        }
        return tab;
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
        if (group.kind === 'project') void refreshProjects();
        return null;
      }
    },
    [applyTabs, createBrowser, info, pushToast, refreshProjects],
  );

  const closeTabs = useCallback(
    (groupKey: string, tabIds: string[]): boolean => {
      if (!tabIds.length) return true;
      const ids = new Set(tabIds);
      const currentTabs = tabsRef.current[groupKey] || [];
      const closing = currentTabs.filter((tab) => ids.has(tab.id));
      if (!closing.length) return true;

      const dirtyClosing = closing.filter((tab) => dirtyTabsRef.current.get(tab.id));
      if (dirtyClosing.length > 0) {
        const names = dirtyClosing
          .map((tab) => tab.descriptor || tab.filePath || tab.id)
          .join('\n');
        const ok = window.confirm(
          `以下文件有未保存的修改，关闭将丢失：\n${names}\n\n是否继续？`,
        );
        if (!ok) return false;
      }

      for (const tab of closing) {
        dirtyTabsRef.current.delete(tab.id);
        if (!tab.sessionId) continue;
        discardSession(tab.sessionId);
        void window.api.pty.kill(tab.sessionId).catch(() => {});
      }

      const remaining = currentTabs.filter((tab) => !ids.has(tab.id));
      const nextTabs = { ...tabsRef.current };
      if (remaining.length > 0) nextTabs[groupKey] = remaining;
      else delete nextTabs[groupKey];
      applyTabs(nextTabs);

      setActiveTabByGroup((previous) => {
        const current = previous[groupKey];
        if (!current || !ids.has(current)) return previous;
        const index = currentTabs.findIndex((tab) => tab.id === current);
        const leftRemaining = remaining.filter(
          (tab) => !(rightIdsByGroupRef.current[groupKey] || []).includes(tab.id),
        );
        const next =
          leftRemaining[Math.min(Math.max(index, 0), Math.max(leftRemaining.length - 1, 0))] ??
          null;
        return { ...previous, [groupKey]: next?.id ?? null };
      });
      setRightIdsByGroup((previous) => {
        const current = (previous[groupKey] || []).filter((id) => !ids.has(id));
        if (current.length === (previous[groupKey] || []).length) return previous;
        const next = { ...previous };
        if (current.length) next[groupKey] = current;
        else delete next[groupKey];
        return next;
      });
      setRightActiveByGroup((previous) => {
        const current = previous[groupKey];
        if (!current || !ids.has(current)) return previous;
        const remainingRight = (rightIdsByGroupRef.current[groupKey] || []).filter(
          (id) => !ids.has(id),
        );
        return { ...previous, [groupKey]: remainingRight[remainingRight.length - 1] ?? null };
      });
      return true;
    },
    [applyTabs],
  );

  const updateBrowserUrl = useCallback((tabId: string, url: string) => {
    setTabsByGroup((previous) => {
      let changed = false;
      const next: Record<string, Tab[]> = {};
      for (const [groupKey, list] of Object.entries(previous)) {
        next[groupKey] = list.map((item) => {
          if (item.id !== tabId || item.url === url) return item;
          changed = true;
          return { ...item, url };
        });
      }
      if (!changed) return previous;
      tabsRef.current = next;
      return next;
    });
  }, []);

  const restartTab = useCallback(
    async (tab: Tab) => {
      if (isBrowserTab(tab)) return;
      const group = groupsByKey.get(tab.groupKey);
      if (!group || !info) return;
      if (!group.exists) {
        pushToast('项目目录不存在，请先编辑项目路径', 'error');
        return;
      }
      const shell = findLaunchTarget(info, tab.shellId);
      if (!shell) {
        pushToast('当前系统没有可用的终端类型', 'error');
        return;
      }
      if (!shell.available) {
        pushToast(shell.hint || `未安装 ${shell.label}，装好后重启 Cmd Toolbox`, 'error');
        return;
      }

      try {
        const { id: sessionId } = await window.api.pty.create({
          groupKey: tab.groupKey,
          cwd: group.path,
          shellId: shell.id,
          cols: 100,
          rows: 30,
          resume: isCliTool(shell.id),
        });
        const previousSession = tab.sessionId;
        discardSession(previousSession);
        void window.api.pty.kill(previousSession).catch(() => {});

        const currentTabs = tabsRef.current[tab.groupKey] || [];
        applyTabs({
          ...tabsRef.current,
          [tab.groupKey]: currentTabs.map((item) =>
            item.id === tab.id
              ? {
                  ...item,
                  sessionId,
                  cwd: group.path,
                  shellId: shell.id,
                  descriptor: item.custom
                    ? item.descriptor
                    : defaultTabTitle(shell.label),
                  exited: false,
                  exitCode: undefined,
                }
              : item,
          ),
        });
        setActiveGroupKey(tab.groupKey);
        setActiveTabByGroup((previous) => ({ ...previous, [tab.groupKey]: tab.id }));
        setFocusTick((value) => value + 1);
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
        if (group.kind === 'project') void refreshProjects();
      }
    },
    [applyTabs, groupsByKey, info, pushToast, refreshProjects],
  );

  const renameTab = useCallback(
    (tab: Tab, rawDescriptor: string) => {
      const shell = info ? findLaunchTarget(info, tab.shellId) : undefined;
      const fallback = isBrowserTab(tab)
        ? '浏览器'
        : defaultTabTitle(shell?.label || '终端');
      const value = rawDescriptor.trim().slice(0, 30);
      const descriptor = value || fallback;
      const custom = Boolean(value) && value !== fallback;
      const currentTabs = tabsRef.current[tab.groupKey] || [];
      applyTabs({
        ...tabsRef.current,
        [tab.groupKey]: currentTabs.map((item) =>
          item.id === tab.id ? { ...item, descriptor, custom } : item,
        ),
      });
      setRenameTarget(null);
      setFocusTick((tick) => tick + 1);
    },
    [applyTabs, info],
  );

  const selectTab = useCallback(
    (tabId: string) => {
      if (!activeGroup) return;
      const onRight = (rightIdsByGroupRef.current[activeGroup.key] || []).includes(tabId);
      if (onRight) {
        setRightActiveByGroup((previous) => ({ ...previous, [activeGroup.key]: tabId }));
        setFocusSideByGroup((previous) => ({ ...previous, [activeGroup.key]: 'right' }));
      } else {
        setActiveTabByGroup((previous) => ({ ...previous, [activeGroup.key]: tabId }));
        setFocusSideByGroup((previous) => ({ ...previous, [activeGroup.key]: 'left' }));
      }
      setFocusTick((tick) => tick + 1);
    },
    [activeGroup],
  );

  const reorderTabs = useCallback(
    (groupKey: string, fromId: string, toId: string, position: 'before' | 'after') => {
      const currentTabs = tabsRef.current[groupKey] || [];
      const nextList = moveById(currentTabs, fromId, toId, position, (tab) => tab.id);
      if (!nextList) return;
      applyTabs({ ...tabsRef.current, [groupKey]: nextList });
    },
    [applyTabs],
  );

  const placeTab = useCallback(
    (
      fromId: string,
      targetId: string | null,
      half: 'left' | 'right',
      position: 'before' | 'after' = half === 'right' ? 'after' : 'before',
    ) => {
      if (!activeGroup) return;
      const key = activeGroup.key;
      const tabs = tabsRef.current[key] || [];
      if (!tabs.some((tab) => tab.id === fromId)) return;

      setRightIdsByGroup((previous) => {
        const current = previous[key] || [];
        let next = current.filter((id) => id !== fromId);
        if (half === 'right') {
          const targetIndex = targetId ? next.indexOf(targetId) : -1;
          if (targetIndex >= 0) {
            const insertAt = position === 'before' ? targetIndex : targetIndex + 1;
            next.splice(insertAt, 0, fromId);
          } else next.push(fromId);
        }
        const copy = { ...previous };
        if (next.length) copy[key] = next;
        else delete copy[key];
        return copy;
      });

      if (half === 'right') {
        setRightActiveByGroup((previous) => ({ ...previous, [key]: fromId }));
        setFocusSideByGroup((previous) => ({ ...previous, [key]: 'right' }));
        setActiveTabByGroup((previous) => {
          if (previous[key] !== fromId) return previous;
          const rightSet = new Set([
            ...(rightIdsByGroupRef.current[key] || []).filter((id) => id !== fromId),
            fromId,
          ]);
          const remainingLeft = tabs.filter((tab) => !rightSet.has(tab.id));
          return { ...previous, [key]: remainingLeft[remainingLeft.length - 1]?.id ?? null };
        });
      } else {
        setFocusSideByGroup((previous) => ({ ...previous, [key]: 'left' }));
        setActiveTabByGroup((previous) => ({ ...previous, [key]: fromId }));
        setRightActiveByGroup((previous) => {
          if (previous[key] !== fromId) return previous;
          const remaining = (rightIdsByGroupRef.current[key] || []).filter((id) => id !== fromId);
          return { ...previous, [key]: remaining[remaining.length - 1] ?? null };
        });
        if (targetId && targetId !== fromId) {
          reorderTabs(key, fromId, targetId, position);
        }
      }
      setFocusTick((tick) => tick + 1);
    },
    [activeGroup, reorderTabs],
  );

  const spawnOnSide = useCallback(
    (side: 'left' | 'right') => {
      if (!activeGroup) return;
      focusSideByGroupRef.current = {
        ...focusSideByGroupRef.current,
        [activeGroup.key]: side,
      };
      setFocusSideByGroup((previous) => ({ ...previous, [activeGroup.key]: side }));
      void createTerminal(activeGroup);
    },
    [activeGroup, createTerminal],
  );

  const handlePaneDragOver = useCallback((event: ReactDragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes(TAB_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const handlePaneDrop = useCallback(
    (event: ReactDragEvent, targetId: string | null) => {
      if (!Array.from(event.dataTransfer.types).includes(TAB_DRAG_TYPE)) return;
      event.preventDefault();
      event.stopPropagation();
      const fromId = event.dataTransfer.getData(TAB_DRAG_TYPE);
      if (!fromId) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const half = event.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
      placeTab(fromId, targetId, half);
    },
    [placeTab],
  );

  const handleSplitPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!activeGroup) return;
      const root = event.currentTarget.parentElement;
      if (!root) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setSplitDragging(true);
      splitDragRef.current = {
        x: event.clientX,
        ratio: splitRatioByGroupRef.current[activeGroup.key] ?? 0.5,
        width: Math.max(root.getBoundingClientRect().width, 80),
      };
    },
    [activeGroup],
  );

  const handleSplitPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!activeGroup || event.buttons === 0) return;
      const start = splitDragRef.current;
      const next = Math.min(0.78, Math.max(0.22, start.ratio + (event.clientX - start.x) / start.width));
      setSplitRatioByGroup((previous) =>
        previous[activeGroup.key] === next ? previous : { ...previous, [activeGroup.key]: next },
      );
    },
    [activeGroup],
  );

  const handleSplitPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    setSplitDragging(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
  }, []);

  const reorderProjects = useCallback(
    async (fromId: string, toId: string, position: 'before' | 'after') => {
      const next = moveById(projects, fromId, toId, position, (project) => project.id);
      if (!next) return;
      setProjects(next);
      try {
        const list = await window.api.projects.reorder(next.map((project) => project.id));
        setProjects(list);
      } catch (error) {
        pushToast(toErrorMessage(error), 'error');
        void refreshProjects();
      }
    },
    [projects, pushToast, refreshProjects],
  );

  const selectGroup = useCallback(
    (groupKey: string) => {
      setActiveGroupKey(groupKey);
      const list = tabsRef.current[groupKey] || [];
      const current = activeTabByGroupRef.current[groupKey];
      if (list.length > 0) {
        if (!list.some((tab) => tab.id === current)) {
          setActiveTabByGroup((previous) => ({
            ...previous,
            [groupKey]: list[list.length - 1].id,
          }));
        }
        setFocusTick((tick) => tick + 1);
      }
    },
    [],
  );

  const revealPath = useCallback(
    (target: string) => {
      void window.api.shell
        .reveal(target)
        .catch((error) => pushToast(toErrorMessage(error), 'error'));
    },
    [pushToast],
  );

  const copyWorkingDirectory = useCallback(
    (target: string, success = '工作目录已复制') => {
      if (!target || target === 'about:blank') {
        pushToast('还没有可复制的内容', 'error');
        return;
      }
      void window.api.clipboard
        .write(target)
        .then(() => pushToast(success, 'success'))
        .catch((error) => pushToast(toErrorMessage(error), 'error'));
    },
    [pushToast],
  );

  const editGroupProject = useCallback(
    (group: Group) => {
      if (!group.projectId) return;
      const project = projects.find((item) => item.id === group.projectId);
      if (project) setProjectModal({ mode: 'edit', project });
    },
    [projects],
  );

  const requestDeleteProject = useCallback(
    (group: Group) => {
      if (!group.projectId) return;
      const project = projects.find((item) => item.id === group.projectId);
      if (project) setDeleteTarget(project);
    },
    [projects],
  );

  const buildShellMenuItems = useCallback(
    (group: Group): MenuEntry[] => {
      if (!info) return [];
      const shells: MenuEntry[] = info.shells.map((shell) => ({
        type: 'item',
        id: `new-${shell.id}`,
        label: shell.label,
        icon: shellIcon(shell.id),
        shortcut: shell.id === info.defaultShellId ? 'Ctrl+T' : undefined,
        onSelect: () => {
          void createTerminal(group, shell.id);
        },
      }));
      const browserItem: MenuEntry = {
        type: 'item',
        id: 'new-browser',
        label: '浏览器',
        icon: shellIcon('browser'),
        onSelect: () => {
          createBrowser(group);
        },
      };
      const tools: MenuEntry[] = (info.tools || []).map((tool) => ({
        type: 'item',
        id: `new-${tool.id}`,
        label: tool.label,
        icon: shellIcon(tool.id),
        disabled: !tool.available,
        title: tool.hint || undefined,
        onSelect: () => {
          if (!tool.available) return;
          void createTerminal(group, tool.id);
        },
      }));
      const extras: MenuEntry[] = [
        { type: 'separator', id: 'shell-browser-sep' },
        browserItem,
      ];
      if (tools.length) {
        extras.push({ type: 'separator', id: 'shell-tools-sep' }, ...tools);
      }
      return [...shells, ...extras];
    },
    [createBrowser, createTerminal, info],
  );

  const openShellMenu = useCallback(
    (event: ReactMouseEvent, group: Group) => {
      event.preventDefault();
      event.stopPropagation();
      if (!info) return;
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      setMenu({
        x: Math.max(8, rect.right - 200),
        y: rect.bottom + 6,
        items: [
          { type: 'label', id: 'pick-shell-label', label: '新建终端' },
          ...buildShellMenuItems(group),
        ],
      });
    },
    [buildShellMenuItems, info],
  );

  const openGroupMenu = useCallback(
    (event: ReactMouseEvent, group: Group) => {
      event.preventDefault();
      event.stopPropagation();
      const items: MenuEntry[] = [
        { type: 'label', id: 'group-menu-label', label: group.name },
        ...buildShellMenuItems(group),
        { type: 'separator', id: 'group-menu-sep-1' },
        {
          type: 'item',
          id: 'group-reveal',
          label: '在资源管理器中打开',
          icon: <FolderOpen size={14} />,
          disabled: !group.exists,
          onSelect: () => revealPath(group.path),
        },
        {
          type: 'item',
          id: 'group-editor',
          label: '打开编辑器',
          icon: <FileCode size={14} />,
          disabled: !group.exists,
          onSelect: () => createEditor(group),
        },
      ];
      if (group.kind === 'project') {
        items.push(
          { type: 'separator', id: 'group-menu-sep-2' },
          {
            type: 'item',
            id: 'group-edit',
            label: '编辑项目',
            icon: <Pencil size={14} />,
            onSelect: () => editGroupProject(group),
          },
          {
            type: 'item',
            id: 'group-delete',
            label: '删除项目',
            icon: <Trash2 size={14} />,
            danger: true,
            onSelect: () => requestDeleteProject(group),
          },
        );
      }
      setMenu({ x: event.clientX, y: event.clientY, items });
    },
    [buildShellMenuItems, createEditor, editGroupProject, requestDeleteProject, revealPath],
  );

  const openTabMenu = useCallback(
    (event: ReactMouseEvent, tab: Tab) => {
      event.preventDefault();
      event.stopPropagation();
      const groupTabs = tabsRef.current[tab.groupKey] || [];
      const items: MenuEntry[] = [
        {
          type: 'item',
          id: 'tab-rename',
          label: '重命名用途',
          icon: <Pencil size={14} />,
          onSelect: () => setRenameTarget({ groupKey: tab.groupKey, tabId: tab.id }),
        },
        {
          type: 'item',
          id: 'tab-copy-path',
          label: isBrowserTab(tab) ? '复制网址' : '复制工作目录',
          icon: <Copy size={14} />,
          onSelect: () =>
            copyWorkingDirectory(
              isBrowserTab(tab) ? tab.url || '' : tab.cwd,
              isBrowserTab(tab) ? '网址已复制' : '工作目录已复制',
            ),
        },
      ];
      if (tab.exited && !isBrowserTab(tab)) {
        items.push({
          type: 'item',
          id: 'tab-restart',
          label: '重新启动终端',
          icon: <RotateCw size={14} />,
          onSelect: () => {
            void restartTab(tab);
          },
        });
      }
      items.push(
        { type: 'separator', id: 'tab-menu-sep-1' },
        {
          type: 'item',
          id: 'tab-close',
          label: '关闭',
          icon: <X size={14} />,
          shortcut: 'Ctrl+W',
          onSelect: () => closeTabs(tab.groupKey, [tab.id]),
        },
        {
          type: 'item',
          id: 'tab-close-others',
          label: '关闭其他',
          icon: <X size={14} />,
          disabled: groupTabs.length <= 1,
          onSelect: () =>
            closeTabs(
              tab.groupKey,
              groupTabs.filter((item) => item.id !== tab.id).map((item) => item.id),
            ),
        },
        {
          type: 'item',
          id: 'tab-close-all',
          label: '关闭全部',
          icon: <X size={14} />,
          onSelect: () => closeTabs(tab.groupKey, groupTabs.map((item) => item.id)),
        },
      );
      setMenu({ x: event.clientX, y: event.clientY, items });
    },
    [closeTabs, copyWorkingDirectory, restartTab],
  );

  const openTerminalMenu = useCallback(
    (event: ReactMouseEvent, tab: Tab, actions: TerminalMenuActions) => {
      event.preventDefault();
      const items: MenuEntry[] = [
        {
          type: 'item',
          id: 'terminal-copy',
          label: '复制',
          icon: <Copy size={14} />,
          shortcut: 'Ctrl+C',
          disabled: !actions.hasSelection(),
          onSelect: actions.copySelection,
        },
        {
          type: 'item',
          id: 'terminal-copy-link',
          label: '复制链接',
          icon: <Link size={14} />,
          disabled: !actions.hasLink(),
          onSelect: actions.copyLink,
        },
        {
          type: 'item',
          id: 'terminal-paste',
          label: '粘贴',
          icon: <CornerDownLeft size={14} />,
          shortcut: 'Ctrl+V',
          onSelect: actions.paste,
        },
        {
          type: 'item',
          id: 'terminal-select-all',
          label: '全选',
          icon: <Check size={14} />,
          onSelect: actions.selectAll,
        },
        { type: 'separator', id: 'terminal-menu-sep-1' },
        {
          type: 'item',
          id: 'terminal-clear',
          label: '清空屏幕',
          icon: <Eraser size={14} />,
          onSelect: actions.clear,
        },
        {
          type: 'item',
          id: 'terminal-restart',
          label: '重新启动终端',
          icon: <RotateCw size={14} />,
          onSelect: () => {
            void restartTab(tab);
          },
        },
        {
          type: 'item',
          id: 'terminal-close',
          label: '关闭页签',
          icon: <X size={14} />,
          onSelect: () => closeTabs(tab.groupKey, [tab.id]),
        },
      ];
      setMenu({ x: event.clientX, y: event.clientY, items });
    },
    [closeTabs, restartTab],
  );

  const submitProject = useCallback(
    async (values: { name: string; path: string }) => {
      if (!projectModal) return;
      const editingId =
        projectModal.mode === 'edit' ? projectModal.project?.id : undefined;
      const result = await window.api.projects.save({ id: editingId, ...values });
      setProjects(result.projects);
      setProjectModal(null);
      setFocusTick((tick) => tick + 1);
      if (!editingId) {
        setActiveGroupKey(projectGroupKey(result.project.id));
        pushToast('项目已保存', 'success');
      } else {
        pushToast('项目已更新', 'success');
      }
    },
    [projectModal, pushToast],
  );

  const confirmDeleteProject = useCallback(async () => {
    if (!deleteTarget) return;
    const groupKey = projectGroupKey(deleteTarget.id);
    // 先关闭页签：若有未保存的编辑，closeTabs 会确认，取消时整个删除中止
    const closed = closeTabs(
      groupKey,
      (tabsRef.current[groupKey] || []).map((tab) => tab.id),
    );
    if (!closed) return;
    const nextProjects = await window.api.projects.remove(deleteTarget.id);
    setProjects(nextProjects);
    if (activeGroupKey === groupKey) setActiveGroupKey(GLOBAL_GROUP_KEY);
    setDeleteTarget(null);
    setFocusTick((tick) => tick + 1);
    pushToast('项目已删除', 'success');
  }, [activeGroupKey, closeTabs, deleteTarget, pushToast]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;

      const target =
        event.target instanceof HTMLElement ? event.target : null;
      const inTerminal = Boolean(target?.closest('.xterm'));
      const inField =
        Boolean(target?.closest('input, textarea, select, [contenteditable="true"]')) &&
        !inTerminal;
      if (inField) return;
      if (projectModal || renameTarget || deleteTarget || menu) return;

      const key = event.key.toLowerCase();
      if (key === 'tab') {
        event.preventDefault();
        event.stopPropagation();
        if (!activeTabs.length) return;
        const direction = event.shiftKey ? -1 : 1;
        const currentIndex = activeTabs.findIndex((tab) => tab.id === effectiveActiveTabId);
        const next =
          activeTabs[
            (Math.max(currentIndex, 0) + direction + activeTabs.length) % activeTabs.length
          ];
        if (next) selectTab(next.id);
        return;
      }

      if (event.shiftKey) return;

      if (key === 't' && activeGroup) {
        event.preventDefault();
        event.stopPropagation();
        void createTerminal(activeGroup);
        return;
      }

      if (key === 'w') {
        const closing = focusSide === 'right' && rightTab ? rightTab : activeTab;
        if (!closing) return;
        event.preventDefault();
        event.stopPropagation();
        closeTabs(closing.groupKey, [closing.id]);
        return;
      }

      if (/^[1-9]$/.test(key)) {
        const next = activeTabs[Number(key) - 1];
        if (next) {
          event.preventDefault();
          event.stopPropagation();
          selectTab(next.id);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [
    activeGroup,
    activeTab,
    activeTabs,
    closeTabs,
    createTerminal,
    deleteTarget,
    effectiveActiveTabId,
    focusSide,
    menu,
    projectModal,
    renameTarget,
    rightTab,
    selectTab,
  ]);

  if (!info) return <BootScreen error={bootError} />;

  const isPaneActive = (tab: Tab) => {
    if (!activeGroup || tab.groupKey !== activeGroup.key) return false;
    if (split) {
      if (rightIds.includes(tab.id)) return tab.id === effectiveRightTabId;
      return tab.id === effectiveActiveTabId;
    }
    return tab.id === effectiveActiveTabId;
  };

  const renderWorkbenchPane = (tab: Tab) => {
    const group = groupsByKey.get(tab.groupKey);
    if (!group) return null;
    const active = isPaneActive(tab);
    if (isBrowserTab(tab)) {
      return (
        <BrowserPane
          key={tab.id}
          tab={tab}
          group={group}
          active={active}
          onClose={(target) => closeTabs(target.groupKey, [target.id])}
          onToast={pushToast}
          onUrlChange={updateBrowserUrl}
        />
      );
    }
    if (isDiffTab(tab) && (tab.diffChange || tab.diffCommit)) {
      return (
        <DiffPane
          key={tab.id}
          projectPath={group.path}
          wordWrap={prefs.editorWordWrap}
          target={
            tab.diffCommit
              ? { kind: 'commit', commit: tab.diffCommit }
              : { kind: 'change', change: tab.diffChange! }
          }
          active={active}
          onClose={() => closeTabs(tab.groupKey, [tab.id])}
          onOpenFile={(relPath) => openEditorFile(group, relPath)}
          onToast={pushToast}
        />
      );
    }
    if (isEditorTab(tab)) {
      return (
        <EditorPane
          key={tab.id}
          tab={tab}
          group={group}
          active={active}
          onClose={(target) => closeTabs(target.groupKey, [target.id])}
          onToast={pushToast}
          onTitleChange={(title) => setTabDescriptor(tab.groupKey, tab.id, title)}
          onDirtyChange={handleDirtyChange}
          themeMode={terminalThemeMode}
          wordWrap={prefs.editorWordWrap}
          tabSize={prefs.editorTabSize}
          indentWithSpaces={prefs.editorIndentWithSpaces}
          keybindings={prefs.editorKeybindings}
        />
      );
    }
    const shellLabel = findLaunchTarget(info, tab.shellId)?.label || '终端';
    return (
      <TerminalPane
        key={tab.id}
        tab={tab}
        group={group}
        themeMode={terminalThemeMode}
        shellLabel={shellLabel}
        active={active}
        focusTick={focusTick}
        fontSize={prefs.fontSize}
        copyOnSelect={prefs.copyOnSelect}
        onFontSizeDelta={(delta) => {
          setPrefs((previous) => {
            const fontSize = Math.min(20, Math.max(11, previous.fontSize + delta));
            const next = { ...previous, fontSize };
            writePrefs(next);
            return next;
          });
        }}
        onRestart={(target) => {
          void restartTab(target);
        }}
        onClose={(target) => closeTabs(target.groupKey, [target.id])}
        onToast={pushToast}
        onTerminalMenu={openTerminalMenu}
      />
    );
  };

  const defaultShell = info.shells.find((shell) => shell.id === info.defaultShellId) || info.shells[0];
  const renameContext = renameTarget
    ? (() => {
        const group = groupsByKey.get(renameTarget.groupKey);
        const tab = (tabsByGroup[renameTarget.groupKey] || []).find(
          (item) => item.id === renameTarget.tabId,
        );
        return group && tab ? { group, tab } : null;
      })()
    : null;
  const deleteTabCount = deleteTarget
    ? (tabsByGroup[projectGroupKey(deleteTarget.id)] || []).length
    : 0;
  const closeProjectModal = () => {
    setProjectModal(null);
    setFocusTick((tick) => tick + 1);
  };
  const closeRenameModal = () => {
    setRenameTarget(null);
    setFocusTick((tick) => tick + 1);
  };
  const closeDeleteDialog = () => setDeleteTarget(null);

  return (
    <div className={`app platform-${info.platform}`}>
      <TitleBar
        themeMode={terminalThemeMode}
        onThemeChange={setTerminalThemeMode}
        updateAvailable={updateCheck?.ok === true && updateCheck.hasUpdate}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="app-body">
        <Sidebar
          groups={groups}
          activeKey={activeGroup?.key || activeGroupKey}
          counts={counts}
          modelStatusByGroup={modelStatusByGroup}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
          onSelectGroup={selectGroup}
          onQuickOpen={(group) => {
            void createTerminal(group);
          }}
          onGroupMenu={openGroupMenu}
          onAddProject={() => setProjectModal({ mode: 'add' })}
          onReorderProjects={reorderProjects}
          gitPanel={
            gitGroup ? (
              <GitPanel
                key={gitGroup.key}
                status={gitStatus}
                refreshing={gitRefreshing}
                onRefresh={() => void refreshGit()}
                onCommit={gitCommit}
                onPush={gitPush}
                onPull={() => void gitPull()}
                pullBusy={pullBusy}
                onInit={gitInit}
                onOpenDiff={(change) => {
                  if (gitGroup) openDiffTab(gitGroup, change);
                }}
                onOpenInEditor={(change) => openEditorFile(gitGroup, change.path)}
                onStage={gitStage}
                onUnstage={gitUnstage}
                onDiscard={gitDiscard}
                onStageAll={gitStageAll}
                onDiscardAll={gitDiscardAll}
                branches={gitBranches.list}
                currentBranch={gitBranches.current}
                branchBusy={branchBusy}
                onCheckout={(branch) => void gitCheckout(branch)}
                onCreateBranch={(name, startPoint) => void gitCreateBranch(name, startPoint)}
                onMerge={(branch) => void gitMerge(branch)}
                onMergeInto={(source, target) => void gitMergeInto(source, target)}
                syncPrompt={syncPrompt}
                syncBusy={syncBusy}
                onSyncChoice={(choice) => void runSyncChoice(choice)}
                onSyncClose={() => setSyncPrompt(null)}
                commits={gitCommits}
                onOpenCommit={(commit) => {
                  if (gitGroup) openCommitDiffTab(gitGroup, commit);
                }}
                head={headCommit}
                onRefreshHead={gitRefreshHead}
                onUndoCommit={gitUndoCommit}
                onAmend={gitAmend}
                onStashSave={gitStashSave}
                stashes={stashes}
                stashBusy={stashBusy}
                onStashPop={gitStashPop}
                onStashDrop={gitStashDrop}
              />
            ) : null
          }
        />

        <main className="workspace">
          {activeGroup && !split ? (
            <>
              <TabStrip
                group={activeGroup}
                tabs={activeTabs}
                activeTabId={effectiveActiveTabId}
                canChooseShell
                onSelectTab={selectTab}
                onCloseTab={(tabId) => closeTabs(activeGroup.key, [tabId])}
                onTabMenu={openTabMenu}
                onRenameTab={(tab) =>
                  setRenameTarget({ groupKey: tab.groupKey, tabId: tab.id })
                }
                onNewTab={() => spawnOnSide('left')}
                onShellMenu={(event) => openShellMenu(event, activeGroup)}
                onReorderTabs={(fromId, toId, position) =>
                  reorderTabs(activeGroup.key, fromId, toId, position)
                }
              />
              <div
                className="pane-area"
                onDragOver={handlePaneDragOver}
                onDrop={(event) => handlePaneDrop(event, effectiveActiveTabId)}
              >
                {activeTabs.length === 0 ? (
                  <EmptyState
                    group={activeGroup}
                    shells={info.shells}
                    defaultShell={defaultShell}
                    canChooseShell
                    onNewTerminal={(shellId) => {
                      void createTerminal(activeGroup, shellId);
                    }}
                    onShellMenu={(event) => openShellMenu(event, activeGroup)}
                    onReveal={() => revealPath(activeGroup.path)}
                    onEditProject={() => editGroupProject(activeGroup)}
                  />
                ) : null}
                {allTabs.map((tab) => renderWorkbenchPane(tab))}
              </div>
            </>
          ) : null}

          {activeGroup && split ? (
            <div className={`workspace-split${splitDragging ? ' is-resizing' : ''}`}>
              <div
                className="workspace-column"
                style={{ flex: `${splitRatio} 1 0` }}
              >
                <TabStrip
                  group={activeGroup}
                  tabs={leftTabs}
                  activeTabId={effectiveActiveTabId}
                  canChooseShell
                  onSelectTab={selectTab}
                  onCloseTab={(tabId) => closeTabs(activeGroup.key, [tabId])}
                  onTabMenu={openTabMenu}
                  onRenameTab={(tab) =>
                    setRenameTarget({ groupKey: tab.groupKey, tabId: tab.id })
                  }
                  onNewTab={() => spawnOnSide('left')}
                  onShellMenu={(event) => openShellMenu(event, activeGroup)}
                  onReorderTabs={(fromId, toId, position) =>
                    reorderTabs(activeGroup.key, fromId, toId, position)
                  }
                  onPlaceTab={(fromId, toId, position) =>
                    placeTab(fromId, toId, 'left', position)
                  }
                />
                <div
                  className="pane-area"
                  onMouseDown={() =>
                    setFocusSideByGroup((previous) => ({
                      ...previous,
                      [activeGroup.key]: 'left',
                    }))
                  }
                  onDragOver={handlePaneDragOver}
                  onDrop={(event) => handlePaneDrop(event, effectiveActiveTabId)}
                >
                  {allTabs
                    .filter(
                      (tab) =>
                        tab.groupKey !== activeGroup.key || !rightIds.includes(tab.id),
                    )
                    .map((tab) => renderWorkbenchPane(tab))}
                </div>
              </div>
              <button
                type="button"
                className={`split-resizer${splitDragging ? ' is-dragging' : ''}`}
                aria-label="调整分屏宽度"
                onPointerDown={handleSplitPointerDown}
                onPointerMove={handleSplitPointerMove}
                onPointerUp={handleSplitPointerUp}
                onPointerCancel={handleSplitPointerUp}
              />
              <div className="workspace-column" style={{ flex: `${1 - splitRatio} 1 0` }}>
                <TabStrip
                  group={activeGroup}
                  tabs={rightTabs}
                  activeTabId={effectiveRightTabId}
                  canChooseShell
                  onSelectTab={selectTab}
                  onCloseTab={(tabId) => closeTabs(activeGroup.key, [tabId])}
                  onTabMenu={openTabMenu}
                  onRenameTab={(tab) =>
                    setRenameTarget({ groupKey: tab.groupKey, tabId: tab.id })
                  }
                  onNewTab={() => spawnOnSide('right')}
                  onShellMenu={(event) => openShellMenu(event, activeGroup)}
                  onReorderTabs={(fromId, toId, position) =>
                    reorderTabs(activeGroup.key, fromId, toId, position)
                  }
                  onPlaceTab={(fromId, toId, position) =>
                    placeTab(fromId, toId, 'right', position)
                  }
                />
                <div
                  className="pane-area"
                  onMouseDown={() =>
                    setFocusSideByGroup((previous) => ({
                      ...previous,
                      [activeGroup.key]: 'right',
                    }))
                  }
                  onDragOver={handlePaneDragOver}
                  onDrop={(event) => handlePaneDrop(event, effectiveRightTabId)}
                >
                  {allTabs
                    .filter(
                      (tab) =>
                        tab.groupKey === activeGroup.key && rightIds.includes(tab.id),
                    )
                    .map((tab) => renderWorkbenchPane(tab))}
                </div>
              </div>
            </div>
          ) : null}
        </main>
      </div>

      {projectModal ? (
        <ProjectModal
          mode={projectModal.mode}
          project={projectModal.project}
          onClose={closeProjectModal}
          onSubmit={submitProject}
        />
      ) : null}

      {renameContext ? (
        <RenameTabModal
          groupName={renameContext.group.name}
          groupColor={renameContext.group.color}
          currentDescriptor={renameContext.tab.descriptor}
          defaultDescriptor={
            isBrowserTab(renameContext.tab)
              ? '浏览器'
              : defaultTabTitle(
                  findLaunchTarget(info, renameContext.tab.shellId)?.label || '终端',
                )
          }
          onClose={closeRenameModal}
          onSave={(descriptor) => renameTab(renameContext.tab, descriptor)}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title="删除项目"
          confirmLabel="删除项目"
          message={
            <>
              <p>
                确定要删除项目「<strong>{deleteTarget.name}</strong>」吗？
              </p>
              {deleteTabCount > 0 ? (
                <p>该项目下打开的 {deleteTabCount} 个终端会同时关闭。</p>
              ) : null}
              <p className="confirm-note">只会移除记录，不会删除磁盘上的任何文件。</p>
            </>
          }
          onClose={closeDeleteDialog}
          onConfirm={confirmDeleteProject}
        />
      ) : null}

      {menu ? <PopupMenu state={menu} onClose={closeMenu} /> : null}

      {settingsOpen ? (
        <SettingsModal
          prefs={prefs}
          version={info.version}
          update={updateCheck}
          updateBusy={updateBusy}
          updater={updater}
          onCheckUpdate={() => void runUpdateCheck('manual')}
          onStartUpdate={() => void startUpdate()}
          onInstallUpdate={() => void installUpdate()}
          onClose={() => setSettingsOpen(false)}
          onSave={(next) => {
            writePrefs(next);
            setPrefs(next);
            setSettingsOpen(false);
          }}
        />
      ) : null}

      {announcement ? (
        <AnnouncementModal
          announcement={announcement}
          updater={updater}
          onStartUpdate={() => void startUpdate()}
          onInstallUpdate={() => void installUpdate()}
          onDismiss={() => {
            writeSeenVersion(announcement.version);
            setAnnouncement(null);
          }}
        />
      ) : null}

      <ToastViewport items={toasts} />
    </div>
  );
}
