import { Download, RefreshCw, RotateCcw, Sparkles } from 'lucide-react';
import { Modal } from './Modal';
import type { ReleaseNote, UpdaterState } from '../types';

export type Announcement = {
  kind: 'available' | 'updated';
  version: string;
  releases: ReleaseNote[];
  url: string;
};

type AnnouncementModalProps = {
  announcement: Announcement;
  updater?: UpdaterState;
  onStartUpdate?: () => void;
  onInstallUpdate?: () => void;
  onDismiss: () => void;
};

export function AnnouncementModal({
  announcement,
  updater,
  onStartUpdate,
  onInstallUpdate,
  onDismiss,
}: AnnouncementModalProps) {
  const available = announcement.kind === 'available';
  const phase = updater?.phase || 'idle';
  const canAutoUpdate = Boolean(onStartUpdate) && phase !== 'unsupported';
  const count = announcement.releases.length;

  return (
    <Modal
      title={available ? `发现新版本 ${announcement.version}` : `已更新到 ${announcement.version}`}
      subtitle={
        available
          ? count > 1
            ? `共 ${count} 个版本的更新，可以直接在应用内更新`
            : '可以直接在应用内更新，也可以去 GitHub 手动下载'
          : count > 1
            ? `本次跨过了 ${count} 个版本`
            : '以下是本次更新的内容'
      }
      icon={available ? <Download size={17} /> : <Sparkles size={17} />}
      width={520}
      onClose={onDismiss}
    >
      {count > 0 ? (
        <div className="announcement-body">
          {announcement.releases.map((release) => (
            <section className="announcement-release" key={release.version}>
              <div className="announcement-release-head">
                <span className="announcement-release-version">{release.version}</span>
                <button
                  type="button"
                  className="announcement-release-link"
                  title={`在浏览器查看 ${release.version} 的 Release`}
                  onClick={() => {
                    void window.api.shell.openExternal(release.url);
                  }}
                >
                  GitHub
                </button>
              </div>
              {release.notes ? (
                <p className="announcement-release-notes">{release.notes}</p>
              ) : (
                <p className="announcement-release-notes is-empty">这个版本没有填写更新说明。</p>
              )}
            </section>
          ))}
        </div>
      ) : (
        <p className="announcement-body is-empty">这个版本没有填写更新说明。</p>
      )}

      {available && phase === 'error' && updater?.message ? (
        <p className="announcement-hint">{updater.message}</p>
      ) : null}

      <div className="announcement-actions">
        {available ? (
          <>
            <button type="button" className="btn btn-secondary" onClick={onDismiss}>
              稍后
            </button>
            {canAutoUpdate ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={phase === 'downloading'}
                onClick={phase === 'downloaded' ? onInstallUpdate : onStartUpdate}
              >
                {phase === 'downloaded' ? <RotateCcw size={13} /> : <RefreshCw size={13} />}
                {phase === 'downloading'
                  ? `下载中 ${updater?.percent ?? 0}%`
                  : phase === 'downloaded'
                    ? '重启并安装'
                    : phase === 'error'
                      ? '重试'
                      : '立即更新'}
              </button>
            ) : (
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
            )}
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
