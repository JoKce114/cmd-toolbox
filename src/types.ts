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
  status: GitChangeStatus;
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
    };

export function isBrowserTab(tab: { shellId: string }): boolean {
  return tab.shellId === 'browser';
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
