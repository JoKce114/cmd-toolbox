import { useState, type FormEvent } from 'react';
import { FolderOpen, FolderPlus, Pencil } from 'lucide-react';
import { folderNameFromPath, toErrorMessage } from '../lib';
import type { Project } from '../types';
import { Modal } from './Modal';

type ProjectModalProps = {
  mode: 'add' | 'edit';
  project?: Project;
  onClose: () => void;
  onSubmit: (values: { name: string; path: string }) => Promise<void>;
};

export function ProjectModal({ mode, project, onClose, onSubmit }: ProjectModalProps) {
  const [name, setName] = useState(project?.name || '');
  const [path, setPath] = useState(project?.path || '');
  const [nameDirty, setNameDirty] = useState(Boolean(project?.name));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const browse = async () => {
    try {
      const selected = await window.api.projects.pickFolder();
      if (!selected) return;
      setPath(selected);
      setError('');
      if (!nameDirty || !name.trim()) {
        setName(folderNameFromPath(selected));
        setNameDirty(false);
      }
    } catch (browseError) {
      setError(toErrorMessage(browseError));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!path.trim()) {
      setError('请填写本地项目目录');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSubmit({ name: name.trim(), path: path.trim() });
    } catch (submitError) {
      setError(toErrorMessage(submitError));
      setBusy(false);
    }
  };

  const title = mode === 'add' ? '添加项目' : '编辑项目';
  const subtitle =
    mode === 'add'
      ? '保存一个本地目录，之后可以随时从这里打开终端。'
      : '修改项目信息，路径变更只影响之后新打开的终端。';

  return (
    <Modal
      title={title}
      subtitle={subtitle}
      icon={mode === 'add' ? <FolderPlus size={17} /> : <Pencil size={16} />}
      onClose={onClose}
      closeDisabled={busy}
    >
      <form className="modal-form" onSubmit={submit}>
        <div className="field">
          <label className="field-label" htmlFor="project-name">
            项目名称
            <span className="field-optional">可选</span>
          </label>
          <input
            id="project-name"
            className="text-input"
            value={name}
            maxLength={60}
            data-autofocus
            placeholder={path ? folderNameFromPath(path) : '例如：商城前端'}
            onChange={(event) => {
              setName(event.target.value);
              setNameDirty(true);
              setError('');
            }}
          />
          <div className="field-hint">留空时自动使用文件夹名称。</div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="project-path">
            项目目录
          </label>
          <div className="path-row">
            <input
              id="project-path"
              className="text-input text-mono"
              value={path}
              spellCheck={false}
              placeholder="D:\projects\my-app"
              onChange={(event) => {
                setPath(event.target.value);
                setError('');
              }}
            />
            <button
              type="button"
              className="btn btn-secondary browse-btn"
              onClick={browse}
              disabled={busy}
            >
              <FolderOpen size={14} strokeWidth={1.8} />
              浏览
            </button>
          </div>
          <div className="field-hint">支持直接粘贴文件夹路径或 file:// 链接。</div>
        </div>

        {error ? (
          <div className="field-error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? '保存中…' : mode === 'add' ? '保存项目' : '保存修改'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
