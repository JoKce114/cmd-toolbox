// 应用内文件剪贴板。
// 刻意不碰系统剪贴板：把文件放进 Windows 剪贴板需要在主进程写
// CF_HDROP 格式，还要处理与资源管理器互操作的各种边界，
// 而这里的需求只是应用内复制粘贴。

export type FileClip = {
  kind: 'copy' | 'cut';
  relPath: string;
  // 记录来源项目，用于拒绝跨项目粘贴
  projectPath: string;
};

export type PasteCheck = { ok: true } | { ok: false; reason: string };

// Windows 路径大小写不敏感，比较前统一成小写并去掉尾部斜杠
function normalizeProjectPath(value: string): string {
  return String(value || '')
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

export function canPaste(clip: FileClip | null, projectPath: string): PasteCheck {
  if (!clip) return { ok: false, reason: '剪贴板为空' };
  if (normalizeProjectPath(clip.projectPath) !== normalizeProjectPath(projectPath)) {
    return { ok: false, reason: '不能跨项目粘贴文件' };
  }
  return { ok: true };
}

// 粘贴到 targetDir 下，保留原文件名
export function pasteTargetDir(clip: FileClip, targetDir: string): string {
  const base = clip.relPath.split('/').pop() || clip.relPath;
  return targetDir ? `${targetDir}/${base}` : base;
}
