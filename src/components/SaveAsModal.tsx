import { useId, useState, type FormEvent } from 'react';
import { FilePlus } from 'lucide-react';
import { Modal } from './Modal';

type SaveAsModalProps = {
  suggestedName: string;
  onClose: () => void;
  // 返回错误文案；返回 null 表示保存成功，弹窗自行关闭
  onSubmit: (relPath: string) => Promise<string | null>;
};

// 与文件树新建文件同一套名字规则；区别是这里允许用 / 分级目录
function validate(relPath: string): string {
  const value = relPath.trim();
  if (!value) return '请填写文件名';
  if (value === '.' || value === '..') return '文件名无效';
  // 盘符路径先单独识别，否则会被冒号或反斜杠规则拦下，提示对不上
  if (/^[A-Za-z]:[\\/]/.test(value)) return '请填写相对项目根的路径';
  // \ 在 Windows 上也是分隔符，放行会让主进程静默建出意外目录
  if (value.includes('\\')) return '请用 / 作为目录分隔符';
  if (/[<>:"|?*]/.test(value)) return '文件名不能包含 < > : " | ? *';
  // 先判绝对路径，否则以 / 开头会先被下面的空段规则拦下，提示词对不上
  if (value.startsWith('/')) return '请填写相对项目根的路径';
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return '目录名不能为空，也不能是 . 或 ..';
  }
  // Windows 会静默去掉结尾的点和空格，导致页签路径与磁盘不一致。
  // .hidden 这类以点开头的名字仍然合法，只拦结尾。
  if (parts.some((part) => part.endsWith('.') || part.endsWith(' '))) {
    return '目录名或文件名不能以点或空格结尾';
  }
  const base = parts[parts.length - 1] || '';
  if (!base.includes('.')) return '文件名需要带扩展名，例如 a.php';
  return '';
}

export function SaveAsModal({ suggestedName, onClose, onSubmit }: SaveAsModalProps) {
  const [value, setValue] = useState(suggestedName);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const invalid = validate(value);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const message = await onSubmit(value.trim());
      if (message) {
        setError(message);
        setBusy(false);
      } else {
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="另存为"
      subtitle="填写相对项目根的路径，父目录会自动创建。"
      icon={<FilePlus size={16} />}
      width={400}
      onClose={onClose}
      closeDisabled={busy}
    >
      <form className="modal-form" onSubmit={submit}>
        <div className="field">
          <label className="field-label" htmlFor={inputId}>
            保存路径
          </label>
          <input
            id={inputId}
            className="text-input text-mono"
            value={value}
            data-autofocus
            spellCheck={false}
            placeholder="例如 app/service/helper.php"
            onChange={(event) => {
              setValue(event.target.value);
              setError('');
            }}
          />
          <div className="field-hint">
            {'用 / 分级目录，例如 app/service/helper.php；文件名需要带扩展名。'}
          </div>
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
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
