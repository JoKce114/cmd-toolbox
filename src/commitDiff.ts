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

// 兜底去引号：git 未关闭 quotePath 时路径会带外层双引号（中文路径很常见）
function dequote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}

// 没有 ---/+++ 也没有 rename 行时（二进制文件、仅改权限），只能从
// `diff --git a/x b/x` 里取路径；这一行同样可能带引号
function pathFromHeader(line: string): string {
  const rest = line.replace(/^diff --git /, '').trim();
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/);
  if (quoted) return dequote(quoted[1]).replace(/^a\//, '');

  // 两侧路径相同时 rest 为 `a/${path} b/${path}`，按长度可直接反解
  if (!rest.startsWith('a/') || !rest.includes(' b/')) return '';
  const size = (rest.length - 5) / 2;
  if (!Number.isInteger(size) || size <= 0) return '';
  const candidate = rest.slice(2, 2 + size);
  return rest === `a/${candidate} b/${candidate}` ? candidate : '';
}

function parseChunk(body: string): CommitFile | null {
  const lines = body.split('\n');
  let status: CommitFile['status'] = 'modified';
  let minusPath = '';
  let plusPath = '';
  let renameFrom = '';
  let renameTo = '';

  for (const line of lines) {
    // 只看头部：hunk 正文里被删除的 `-- x` 会渲染成 `--- x`，
    // 新增的 `++ x` 会渲染成 `+++ x`，继续扫下去会把文件路径覆盖掉
    if (line.startsWith('@@ ')) break;

    if (line.startsWith('new file mode')) {
      status = 'added';
    } else if (line.startsWith('deleted file mode')) {
      status = 'deleted';
    } else if (line.startsWith('rename from ')) {
      renameFrom = dequote(line.slice('rename from '.length));
      status = 'renamed';
    } else if (line.startsWith('rename to ')) {
      renameTo = dequote(line.slice('rename to '.length));
      status = 'renamed';
    } else if (line.startsWith('--- ')) {
      const value = dequote(line.slice(4));
      if (value !== '/dev/null') minusPath = value.replace(/^a\//, '');
    } else if (line.startsWith('+++ ')) {
      const value = dequote(line.slice(4));
      if (value !== '/dev/null') plusPath = value.replace(/^b\//, '');
    }
  }

  // 纯重命名没有 ---/+++ 行；删除文件只有 --- 侧；新增文件只有 +++ 侧；
  // 二进制 / 仅改权限的文件两者都没有，退回 diff --git 行
  const path =
    plusPath || renameTo || minusPath || renameFrom || pathFromHeader(lines[0] || '');
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
