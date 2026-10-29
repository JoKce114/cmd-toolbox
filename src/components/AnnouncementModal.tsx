import { Download, Sparkles } from 'lucide-react';
import { Modal } from './Modal';

export type Announcement = {
  kind: 'available' | 'updated';
  version: string;
  notes: string;
  url: string;
};

type AnnouncementModalProps = {
  announcement: Announcement;
  onDismiss: () => void;
};

export function AnnouncementModal({ announcement, onDismiss }: AnnouncementModalProps) {
  const available = announcement.kind === 'available';

  return (
    <Modal
      title={available ? `发现新版本 ${announcement.version}` : `已更新到 ${announcement.version}`}
      subtitle={available ? '在 GitHub 下载新的便携版覆盖旧文件' : '以下是本次更新的内容'}
      icon={available ? <Download size={17} /> : <Sparkles size={17} />}
      width={520}
      onClose={onDismiss}
    >
      {announcement.notes ? (
        <p className="announcement-body">{announcement.notes}</p>
      ) : (
        <p className="announcement-body is-empty">这个版本没有填写更新说明。</p>
      )}

      <div className="announcement-actions">
        {available ? (
          <>
            <button type="button" className="btn btn-secondary" onClick={onDismiss}>
              稍后
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                void window.api.shell.openExternal(announcement.url);
                onDismiss();
              }}
            >
              <Download size={13} />
              前往下载
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onDismiss}>
            知道了
          </button>
        )}
      </div>
    </Modal>
  );
}
