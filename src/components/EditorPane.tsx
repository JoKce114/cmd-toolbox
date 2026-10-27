import { cn } from '../lib';
import type { Group, Tab } from '../types';
import type { ToastKind } from './Toast';

export type EditorPaneProps = {
  tab: Tab;
  group: Group;
  active: boolean;
  onClose: (tab: Tab) => void;
  onToast: (message: string, kind?: ToastKind) => void;
  onTitleChange: (title: string) => void;
};

export function EditorPane({ tab, group, active }: EditorPaneProps) {
  return (
    <section className={cn('terminal-pane', 'editor-pane', !active && 'is-hidden')}>
      <header className="pane-header">
        <span className="pane-path">{group.name}</span>
      </header>
      <div className="editor-body">
        <p className="editor-placeholder">{tab.filePath || '尚未打开文件'}</p>
      </div>
    </section>
  );
}
