// 两段文本的最小 unified diff。
// 仓库里没有 diff 库，而 diffParser.parsePatch 已经能解析 unified diff，
// 所以这里只负责生成标准格式，渲染完全复用 DiffPane。

type Op = { kind: 'equal' | 'insert' | 'delete'; text: string };

// LCS 动态规划。文件是编辑器里的文本，行数上万时 O(n*m) 会吃内存，
// 所以先剥掉首尾公共部分，只对中间不同的区间做 DP。
function diffLines(oldLines: string[], newLines: string[]): Op[] {
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start += 1;
  }

  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const ops: Op[] = [];
  for (let index = 0; index < start; index += 1) {
    ops.push({ kind: 'equal', text: oldLines[index] });
  }

  const a = oldLines.slice(start, oldEnd);
  const b = newLines.slice(start, newEnd);
  const n = a.length;
  const m = b.length;

  if (n > 0 || m > 0) {
    // table[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
    const table: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i][j] =
          a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }

    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push({ kind: 'equal', text: a[i] });
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        ops.push({ kind: 'delete', text: a[i] });
        i += 1;
      } else {
        ops.push({ kind: 'insert', text: b[j] });
        j += 1;
      }
    }
    while (i < n) {
      ops.push({ kind: 'delete', text: a[i] });
      i += 1;
    }
    while (j < m) {
      ops.push({ kind: 'insert', text: b[j] });
      j += 1;
    }
  }

  for (let index = oldEnd; index < oldLines.length; index += 1) {
    ops.push({ kind: 'equal', text: oldLines[index] });
  }
  return ops;
}

// 把连续的改动聚成一个 hunk，前后各带 3 行上下文（与 git 默认一致）
function buildHunks(ops: Op[]): string[] {
  const CONTEXT = 3;
  const hunks: string[] = [];

  let index = 0;
  while (index < ops.length) {
    if (ops[index].kind === 'equal') {
      index += 1;
      continue;
    }

    // 往前带上下文
    const head = Math.max(0, index - CONTEXT);
    let end = index;
    // 向后吞掉改动，直到后面有超过 2*CONTEXT 行的公共段
    let gap = 0;
    while (end < ops.length) {
      if (ops[end].kind === 'equal') {
        gap += 1;
        if (gap > CONTEXT * 2) break;
      } else {
        gap = 0;
      }
      end += 1;
    }
    // 结尾再带 CONTEXT 行上下文
    const tail = Math.min(ops.length, end);
    const slice = ops.slice(head, tail);

    let oldStart = 1;
    let newStart = 1;
    for (let k = 0; k < head; k += 1) {
      if (ops[k].kind !== 'insert') oldStart += 1;
      if (ops[k].kind !== 'delete') newStart += 1;
    }

    const oldCount = slice.filter((op) => op.kind !== 'insert').length;
    const newCount = slice.filter((op) => op.kind !== 'delete').length;
    const lines = [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`];
    for (const op of slice) {
      const prefix = op.kind === 'insert' ? '+' : op.kind === 'delete' ? '-' : ' ';
      lines.push(`${prefix}${op.text}`);
    }
    hunks.push(lines.join('\n'));
    index = tail;
  }

  return hunks;
}

export function buildTextPatch(
  oldName: string,
  oldText: string,
  newName: string,
  newText: string,
): string {
  const oldLines = String(oldText ?? '').split(/\r?\n/);
  const newLines = String(newText ?? '').split(/\r?\n/);
  // 末尾换行会切出一个空串，比对时不该算作一行差异
  if (oldLines.length && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();

  if (oldLines.join('\n') === newLines.join('\n')) return '';

  const ops = diffLines(oldLines, newLines);
  const hunks = buildHunks(ops);
  if (!hunks.length) return '';

  return [`--- ${oldName}`, `+++ ${newName}`, ...hunks].join('\n');
}
