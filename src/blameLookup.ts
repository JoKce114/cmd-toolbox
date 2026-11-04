import { parsePatch } from './diffParser';
import type { DiffHunk } from './diffParser';

export type BlameInfo = {
  hash: string;
  short: string;
  author: string;
  authorTime: number;
  summary: string;
  origLine: number;
};

export async function lookupBlame(
  projectPath: string,
  filePath: string,
  line: number,
): Promise<BlameInfo | null> {
  try {
    return await window.api.git.blame(projectPath, filePath, line);
  } catch {
    return null;
  }
}

export async function lookupCommitFileDiff(
  projectPath: string,
  hash: string,
  filePath: string,
): Promise<string> {
  try {
    const result = await window.api.git.showFileDiff(projectPath, hash, filePath);
    return result.patch;
  } catch {
    return '';
  }
}

// blame 的 origLine 是该提交版本里的行号，对应 patch 的新侧。只看旧侧会漏掉
// 新增文件的 -0,0 hunk（这种提交整篇都在新侧），而首次提交恰恰是这样。
export function pickHunkForLine(patch: string, line: number): DiffHunk | null {
  const parsed = parsePatch(patch);
  const covers = (startText: string | undefined, countText: string | undefined) => {
    const start = Number(startText);
    const count = countText === undefined ? 1 : Number(countText);
    return line >= start && line < start + Math.max(count, 1);
  };

  for (const hunk of parsed.hunks) {
    const match = hunk.header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    if (covers(match[3], match[4]) || covers(match[1], match[2])) return hunk;
  }
  return null;
}
