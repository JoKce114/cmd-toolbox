import { useState } from 'react';
import { GitMerge, TriangleAlert } from 'lucide-react';
import { Modal } from './Modal';
import type { SyncPrompt } from '../types';

export type SyncChoice = 'merge' | 'rebase' | 'force' | 'repair';

type SyncDialogProps = {
  prompt: SyncPrompt;
  busy: boolean;
  onChoose: (choice: SyncChoice) => void;
  onClose: () => void;
};

const TITLE: Record<SyncPrompt['kind'], string> = {
  'push-rejected': '推送被拒绝',
  diverged: '本地和线上已分叉',
  'multiple-branches': '上游配置异常',
};

const HINT: Record<SyncPrompt['kind'], string> = {
  'push-rejected':
    '拉取会把线上提交合并进来再一起推送；强制推送会用本地覆盖线上，对方的提交会丢失。',
  diverged:
    '合并会生成一个合并提交；变基会把本地提交接到线上提交之后，历史更线性。',
  'multiple-branches':
    '修复只保留指向当前分支的那条配置；也可以到终端手动检查 .git/config。',
};

export function SyncDialog({ prompt, busy, onChoose, onClose }: SyncDialogProps) {
  const [pending, setPending] = useState<SyncChoice | null>(null);

  const choose = (choice: SyncChoice) => {
    setPending(choice);
    onChoose(choice);
  };

  const busyLabel = (choice: SyncChoice, label: string) =>
    busy && pending === choice ? '处理中…' : label;

  return (
    <Modal
      title={TITLE[prompt.kind]}
      icon={<TriangleAlert size={17} />}
      width={460}
      onClose={onClose}
      closeDisabled={busy}
    >
      <p className="sync-message">{prompt.message}</p>
      <p className="sync-hint">{HINT[prompt.kind]}</p>

      <div className="sync-actions">
        {prompt.kind === 'multiple-branches' ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => choose('repair')}
          >
            {busyLabel('repair', '修复上游配置')}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => choose('merge')}
            >
              <GitMerge size={13} />
              {busyLabel('merge', '拉取（合并）')}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => choose('rebase')}
            >
              {busyLabel('rebase', '拉取（变基）')}
            </button>
            {prompt.kind === 'push-rejected' ? (
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => choose('force')}
              >
                {busyLabel('force', '强制推送')}
              </button>
            ) : null}
          </>
        )}
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>
          取消
        </button>
      </div>
    </Modal>
  );
}
