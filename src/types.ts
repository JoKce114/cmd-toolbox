import type { ReactNode } from 'react';

export type ShellInfo = {
  id: string;
  label: string;
  available: boolean;
  hint?: string;
};

export type AppInfo = {
  version: string;
  platform: string;
  homeDir: string;
  dataDir: string;
  shells: ShellInfo[];
  tools: ShellInfo[];
  defaultShellId: string;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  updatedAt: number;
  exists: boolean;
};

export type Group = {
  key: string;
  kind: 'global' | 'project';
  projectId?: string;
  name: string;
  path: string;
  exists: boolean;
  color: string;
};

export type Tab = {
  id: string;
  groupKey: string;
  sessionId: string;
  shellId: string;
  seq: number;
  paneNo: number;
  descriptor: string;
  custom: boolean;
  cwd: string;
  url?: string;
  conversationId?: string;
  filePath?: string;
  diffChange?: GitChange;
  exited: boolean;
  exitCode?: number;
};

export type GitChangeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

export type GitChange = {
  path: string;
  origPath?: string;
  indexStatus: GitChangeStatus | null;
  worktreeStatus: GitChangeStatus | null;
};

export type HeadCommit = {
  hash: string;
  short: string;
  subject: string;
  message: string;
  pushed: boolean;
};

export type StashEntry = {
  ref: string;
  message: string;
  when: string;
};

export type GitStatus =
  | {
      ok: false;
      reason: 'no-git' | 'not-repo' | 'missing-dir' | 'error';
      message: string;
    }
  | {
      ok: true;
      branch: string;
      upstream: string;
      ahead: number;
      behind: number;
      changes: GitChange[];
      hasChanges: boolean;
      stagedCount: number;
      unstagedCount: number;
    };

export type GitPullStrategy = 'ff' | 'merge' | 'rebase';

export type GitSyncFailure = {
  ok: false;
  reason: 'no-upstream' | 'diverged' | 'conflict' | 'rejected' | 'multiple-branches';
  message: string;
  conflicted?: string[];
};

export type GitPullResult =
  | { ok: true; strategy: GitPullStrategy; branch: string; upstream: string }
  | GitSyncFailure;

export type GitPushResult = { ok: true; upstream: string } | GitSyncFailure;

export type SyncPrompt = {
  kind: 'push-rejected' | 'diverged' | 'multiple-branches';
  message: string;
};

export type UpdateAnnounce = 'available' | 'updated' | null;

export type UpdateCheckResult =
  | {
      ok: true;
      current: string;
      latest: string | null;
      hasUpdate: boolean;
      url: string;
      notes: string;
      announce: UpdateAnnounce;
    }
  | { ok: false; message: string };

export type UpdaterPhase = 'idle' | 'downloading' | 'downloaded' | 'error' | 'unsupported';

export type UpdaterState = {
  phase: UpdaterPhase;
  percent: number;
  version: string;
  message: string;
};

export type UpdaterResult = { ok: true } | { ok: false; message: string };

export function isBrowserTab(tab: { shellId: string }): boolean {
  return tab.shellId === 'browser';
}

export function isEditorTab(tab: { shellId: string }): boolean {
  return tab.shellId === 'editor';
}

export function isDiffTab(tab: { shellId: string }): boolean {
  return tab.shellId === 'diff';
}

export type MenuEntry =
  | { type: 'separator'; id: string }
  | { type: 'label'; id: string; label: string }
  | {
      type: 'item';
      id: string;
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      title?: string;
      onSelect: () => void;
    };

export type MenuState = {
  x: number;
  y: number;
  items: MenuEntry[];
};

export const GLOBAL_GROUP_KEY = 'global';

export function projectGroupKey(projectId: string) {
  return `project:${projectId}`;
}

export type FileEntry = {
  name: string;
  relPath: string;
  isDir: boolean;
  isSymlink: boolean;
};

export type OpenedFile = {
  content: string;
  encoding: string;
  size: number;
  readOnly: boolean;
  mtime: number;
};
