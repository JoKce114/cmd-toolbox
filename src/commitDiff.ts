import { parsePatch } from './diffParser';
import type { CommitFile } from './types';

// 一个提交的 patch 里每个文件以 "diff --git " 开头；内容行都带 +/-/空格前缀，不会误切
export function splitCommitPatch(patch: string): CommitFile[] {
  if (!patch.trim()) return [];
  return patch
    .split(/^diff --git /m)
    .slice(1)
    .map((chunk) => parseChunk(`diff --git ${chunk}`))
    .filter((file): file is CommitFile => file !== null);
}

function parseChunk(body: string): CommitFile | null {
  const lines = body.split('\n');
  let status: CommitFile['status'] = 'modified';
  let minusPath = '';
  let plusPath = '';
  let renameFrom = '';
  let renameTo = '';

  for (const line of lines) {
    if (line.startsWith('new file mode')) {
      status = 'added';
    } else if (line.startsWith('deleted file mode')) {
      status = 'deleted';
    } else if (line.startsWith('rename from ')) {
      renameFrom = line.slice('rename from '.length).trim();
      status = 'renamed';
    } else if (line.startsWith('rename to ')) {
      renameTo = line.slice('rename to '.length).trim();
      status = 'renamed';
    } else if (line.startsWith('--- ')) {
      const value = line.slice(4).trim();
      if (value !== '/dev/null') minusPath = value.replace(/^a\//, '');
    } else if (line.startsWith('+++ ')) {
      const value = line.slice(4).trim();
      if (value !== '/dev/null') plusPath = value.replace(/^b\//, '');
    }
  }

  // 纯重命名没有 ---/+++ 行；删除文件只有 --- 侧；新增文件只有 +++ 侧
  const path = plusPath || renameTo || minusPath || renameFrom;
  if (!path) return null;

  const parsed = parsePatch(body);
  return {
    path,
    origPath: renameFrom || undefined,
    status,
    added: parsed.added,
    removed: parsed.removed,
    patch: body,
  };
}
