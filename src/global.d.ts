import type {
  AppInfo,
  FileEntry,
  GitChange,
  GitPullResult,
  GitPullStrategy,
  GitPushResult,
  GitStatus,
  HeadCommit,
  OpenedFile,
  Project,
  StashEntry,
  UpdateCheckResult,
  UpdaterResult,
  UpdaterState,
} from './types';

export interface ProjectSaveResult {
  projects: Project[];
  project: Project;
}

export interface SessionTab {
  id: string;
  groupKey: string;
  shellId: string;
  seq: number;
  paneNo: number;
  descriptor: string;
  custom: boolean;
  cwd: string;
  url?: string;
  conversationId?: string;
  filePath?: string;
  diffChange?: import('./types').GitChange | null;
}

export interface SessionSnapshot {
  activeGroupKey: string;
  tabs: SessionTab[];
  activeTabByGroup: Record<string, string | null>;
  sidebarCollapsed?: boolean;
  rightIdsByGroup?: Record<string, string[]>;
  rightActiveByGroup?: Record<string, string | null>;
  focusSideByGroup?: Record<string, 'left' | 'right'>;
  splitRatioByGroup?: Record<string, number>;
}

export interface PtyCreateInput {
  groupKey: string;
  cwd: string;
  shellId: string;
  cols: number;
  rows: number;
  resume?: boolean;
  resumeId?: string;
  sessionId?: string;
}

declare global {
  interface Window {
    api: {
      getInfo: () => Promise<AppInfo>;
      updates: {
        check: (seenVersion?: string | null) => Promise<UpdateCheckResult>;
      };
      updater: {
        download: () => Promise<UpdaterResult>;
        install: () => Promise<UpdaterResult>;
        state: () => Promise<UpdaterState>;
        onEvent: (handler: (state: UpdaterState) => void) => () => void;
      };
      session: {
        load: () => Promise<SessionSnapshot>;
        save: (payload: SessionSnapshot) => Promise<SessionSnapshot>;
        saveSync: (payload: SessionSnapshot) => boolean;
      };
      onWillQuit: (handler: () => void) => () => void;
      projects: {
        list: () => Promise<Project[]>;
        save: (input: { id?: string; name: string; path: string }) => Promise<ProjectSaveResult>;
        remove: (id: string) => Promise<Project[]>;
        reorder: (ids: string[]) => Promise<Project[]>;
        pickFolder: () => Promise<string | null>;
      };
      pty: {
        create: (input: PtyCreateInput) => Promise<{ id: string }>;
        write: (id: string, data: string) => void;
        wheel: (id: string, delta: 120 | -120, col: number, row: number) => void;
        click: (id: string, col: number, row: number) => void;
        altV: (id: string) => void;
        resize: (id: string, cols: number, rows: number) => void;
        kill: (id: string) => Promise<boolean>;
        resetAll: () => Promise<boolean>;
        onData: (handler: (id: string, data: string) => void) => () => void;
        onExit: (handler: (id: string, code: number) => void) => () => void;
      };
      shell: {
        reveal: (target: string) => Promise<boolean>;
        openExternal: (url: string) => Promise<boolean>;
      };
      git: {
        status: (projectPath: string) => Promise<GitStatus>;
        commit: (
          projectPath: string,
          message: string,
        ) => Promise<{ commit: string; summary: string }>;
        push: (projectPath: string, options?: { force?: boolean }) => Promise<GitPushResult>;
        fileDiff: (
          projectPath: string,
          filePath: string,
          changeStatus: string,
        ) => Promise<{ patch: string; untracked: boolean }>;
        log: (
          projectPath: string,
          limit?: number,
        ) => Promise<{
          commits: Array<{ hash: string; short: string; author: string; when: string; subject: string }>;
        }>;
        fetch: (projectPath: string) => Promise<{ ok: true }>;
        pull: (
          projectPath: string,
          options?: { strategy?: GitPullStrategy },
        ) => Promise<GitPullResult>;
        repairUpstream: (
          projectPath: string,
        ) => Promise<{ ok: true; branch: string; changed: boolean }>;
        init: (projectPath: string) => Promise<{ ok: true }>;
        diff: (
          projectPath: string,
          filePath: string,
          changeStatus: NonNullable<GitChange['worktreeStatus']>,
        ) => Promise<{ command: string }>;
        stage: (projectPath: string, paths: string[]) => Promise<{ ok: true }>;
        unstage: (projectPath: string, paths: string[]) => Promise<{ ok: true }>;
        discard: (
          projectPath: string,
          payload: { tracked: string[]; untracked: string[] },
        ) => Promise<{ ok: true }>;
        stageAll: (projectPath: string) => Promise<{ ok: true }>;
        discardAll: (projectPath: string) => Promise<{ ok: true }>;
        branches: (projectPath: string) => Promise<{ current: string; list: string[] }>;
        checkout: (projectPath: string, branch: string) => Promise<{ ok: true }>;
        createBranch: (
          projectPath: string,
          name: string,
          startPoint: string,
        ) => Promise<{ ok: true }>;
        merge: (
          projectPath: string,
          branch: string,
        ) => Promise<{ ok: true; conflicted: string[] }>;
        mergeInto: (
          projectPath: string,
          source: string,
          target: string,
        ) => Promise<{
          ok: true;
          conflicted: string[];
          source: string;
          target: string;
          switchedFrom: string;
          returnedTo: string;
        }>;
        headCommit: (projectPath: string) => Promise<HeadCommit | null>;
        undoCommit: (
          projectPath: string,
        ) => Promise<{ message: string; wasPushed: boolean }>;
        amend: (
          projectPath: string,
          message: string,
        ) => Promise<{ commit: string; summary: string }>;
        stashList: (projectPath: string) => Promise<{ stashes: StashEntry[] }>;
        stashSave: (projectPath: string) => Promise<{ ok: true }>;
        stashPop: (
          projectPath: string,
          ref: string,
        ) => Promise<{ ok: true; conflicts: string[] }>;
        stashDrop: (projectPath: string, ref: string) => Promise<{ ok: true }>;
        commitDiff: (projectPath: string, hash: string) => Promise<{ patch: string }>;
      };
      files: {
        list: (projectPath: string, relDir: string) => Promise<{ entries: FileEntry[] }>;
        read: (projectPath: string, relPath: string) => Promise<OpenedFile>;
        write: (
          projectPath: string,
          relPath: string,
          content: string,
          encoding: string,
          mtime: number,
        ) => Promise<{ ok: true }>;
        search: (
          projectPath: string,
          query: string,
          options: { caseSensitive: boolean },
        ) => Promise<{
          matches: Array<{ relPath: string; line: number; text: string; column: number }>;
          truncated: boolean;
          scanned: number;
        }>;
      };
      panes: {
        sync: (panes: Array<Record<string, unknown>>) => void;
        attachBrowser: (tabId: string, webContentsId: number) => void;
      };
      clipboard: {
        read: () => Promise<string>;
        write: (text: string) => Promise<boolean>;
        hasImage: () => Promise<boolean>;
      };
    };
  }
}

export {};
