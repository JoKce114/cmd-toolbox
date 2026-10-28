import type { AppInfo, FileEntry, GitChange, GitStatus, OpenedFile, Project } from './types';

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
        push: (projectPath: string) => Promise<{ upstream: string }>;
        fileDiff: (
          projectPath: string,
          filePath: string,
          changeStatus: string,
        ) => Promise<{ patch: string; untracked: boolean }>;
        fetch: (projectPath: string) => Promise<{ ok: true }>;
        pull: (projectPath: string) => Promise<{ ok: true }>;
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
