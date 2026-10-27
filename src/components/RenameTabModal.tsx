import { useState, type FormEvent } from 'react';
import { Pencil } from 'lucide-react';
import { Modal } from './Modal';

type RenameTabModalProps = {
  groupName: string;
  groupColor: string;
  currentDescriptor: string;
  defaultDescriptor: string;
  onClose: () => void;
  onSave: (descriptor: string) => void;
};

export function RenameTabModal({
  groupName,
  groupColor,
  currentDescriptor,
  defaultDescriptor,
  onClose,
  onSave,
}: RenameTabModalProps) {
  const [value, setValue] = useState(currentDescriptor);
  const trimmed = value.trim();
  const preview = trimmed || defaultDescriptor;

  const save = (event: FormEvent) => {
    event.preventDefault();
    onSave(trimmed);
  };

  return (
    <Modal
      title="重命名终端用途"
      subtitle="页签始终保留项目名，这里只修改用途说明。"
      icon={<Pencil size={16} />}
      width={420}
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={save}>
        <div className="field">
          <label className="field-label" htmlFor="tab-purpose">
            用途名称
          </label>
          <input
            id="tab-purpose"
            className="text-input"
            value={value}
            maxLength={30}
            data-autofocus
            placeholder={defaultDescriptor}
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="field-hint">
            例如：前端、后端、启动服务。留空则恢复默认名称。
            <button
              type="button"
              className="link-button"
              onClick={() => setValue('')}
            >
              使用默认
            </button>
          </div>
        </div>

        <div className="rename-preview" aria-live="polite">
          <span className="rename-preview-dot" style={{ backgroundColor: groupColor }} />
          <span className="rename-preview-project">{groupName}</span>
          <span className="rename-preview-sep">·</span>
          <span className="rename-preview-func">{preview}</span>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary">
            保存名称
          </button>
        </div>
      </form>
    </Modal>
  );
}
