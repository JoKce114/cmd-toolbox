export type DiffLineKind = 'context' | 'added' | 'removed' | 'header' | 'meta';

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

export type DiffHunk = {
  header: string;
  lines: DiffLine[];
};

export type ParsedDiff = {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  isEmpty: boolean;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// 把 git 的 unified diff 解析成可按行着色的结构。
// 只处理正文，文件头（diff --git / index / --- / +++）归为 meta。
export function parsePatch(patch: string): ParsedDiff {
  const lines = patch.split('\n');
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let added = 0;
  let removed = 0;

  for (const raw of lines) {
    if (raw === '' && !current) continue;

    const header = raw.match(HUNK_HEADER);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      current = { header: raw, lines: [] };
      hunks.push(current);
      continue;
    }

    if (!current) {
      if (raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('similarity') || raw.startsWith('rename ')) {
        continue;
      }
      continue;
    }

    if (raw.startsWith('\\')) {
      // "\ No newline at end of file" 附着在上一行，不算新行
      continue;
    }

    const marker = raw.charAt(0);
    if (marker === '+') {
      current.lines.push({ kind: 'added', text: raw.slice(1), oldLine: null, newLine });
      newLine += 1;
      added += 1;
    } else if (marker === '-') {
      current.lines.push({ kind: 'removed', text: raw.slice(1), oldLine, newLine: null });
      oldLine += 1;
      removed += 1;
    } else if (marker === ' ') {
      current.lines.push({ kind: 'context', text: raw.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  return { hunks, added, removed, isEmpty: hunks.length === 0 };
}
