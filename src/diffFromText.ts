// 两段文本的最小 unified diff。
// 仓库里没有 diff 库，而 diffParser.parsePatch 已经能解析 unified diff，
// 所以这里只负责生成标准格式，渲染完全复用 DiffPane。

type Op = { kind: 'equal' | 'insert' | 'delete'; text: string };

// 把行映射成整数 id 再比较，避免 Myers 内层循环反复做字符串比较。
type LineSource = { ids: Int32Array; texts: string[] };

// 极端大文件兜底：两侧剩余行数都超过这个值时不再跑差分，直接全删全增。
// 这是为了避免任何 O(N*M) / O((N+M)^2) 算法在大文件上长时间卡住。
const LARGE_FILE_LIMIT = 20000;

type Snake = { x: number; y: number };

// Myers 线性空间变体：从两端同时按编辑距离向外扩展，找到中间蛇。
// 返回的是相对 a/b 起点的切分坐标，调用方据此分治。
function findMiddleSnake(
  a: LineSource,
  aStart: number,
  aEnd: number,
  b: LineSource,
  bStart: number,
  bEnd: number,
): Snake | null {
  const n = aEnd - aStart;
  const m = bEnd - bStart;
  const aIds = a.ids;
  const bIds = b.ids;
  const max = Math.ceil((n + m) / 2);
  const vLength = 2 * max + 2;
  const vOffset = max + 1;

  const v1 = new Int32Array(vLength).fill(-1);
  const v2 = new Int32Array(vLength).fill(-1);
  v1[vOffset + 1] = 0;
  v2[vOffset + 1] = 0;

  const delta = n - m;
  const front = Math.abs(delta) % 2 === 1;

  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;

  for (let d = 0; d < max; d += 1) {
    // 正向推进
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1Offset = vOffset + k1;
      let x1: number;
      if (k1 === -d || (k1 !== d && v1[k1Offset - 1] < v1[k1Offset + 1])) {
        x1 = v1[k1Offset + 1];
      } else {
        x1 = v1[k1Offset - 1] + 1;
      }
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && aIds[aStart + x1] === bIds[bStart + y1]) {
        x1 += 1;
        y1 += 1;
      }
      v1[k1Offset] = x1;

      if (x1 > n) {
        k1end += 2;
      } else if (y1 > m) {
        k1start += 2;
      } else if (front) {
        const k2Offset = vOffset + delta - k1;
        if (k2Offset >= 0 && k2Offset < vLength && v2[k2Offset] !== -1) {
          const x2 = n - v2[k2Offset];
          if (x1 >= x2) {
            return { x: aStart + x1, y: bStart + y1 };
          }
        }
      }
    }

    // 反向推进
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2Offset = vOffset + k2;
      let x2: number;
      if (k2 === -d || (k2 !== d && v2[k2Offset - 1] < v2[k2Offset + 1])) {
        x2 = v2[k2Offset + 1];
      } else {
        x2 = v2[k2Offset - 1] + 1;
      }
      let y2 = x2 - k2;
      while (
        x2 < n &&
        y2 < m &&
        aIds[aStart + n - x2 - 1] === bIds[bStart + m - y2 - 1]
      ) {
        x2 += 1;
        y2 += 1;
      }
      v2[k2Offset] = x2;

      if (x2 > n) {
        k2end += 2;
      } else if (y2 > m) {
        k2start += 2;
      } else if (!front) {
        const k1Offset = vOffset + delta - k2;
        if (k1Offset >= 0 && k1Offset < vLength && v1[k1Offset] !== -1) {
          const x1 = v1[k1Offset];
          const y1 = x1 - (k1Offset - vOffset);
          if (x1 >= n - x2) {
            return { x: aStart + x1, y: bStart + y1 };
          }
        }
      }
    }
  }

  return null;
}

// 判断两个区间里是否存在任意一行相同。用较小的区间建 Set，遍历另一方，
// 时间 O(N+M)、空间 O(min(N,M))。无交集时 LCS 为 0，最优差分必然是
// 「全部删除 + 全部新增」，可以直接跳过 Myers 的 O((N+M)D) 退化。
function hasCommonLine(
  a: LineSource,
  aStart: number,
  aEnd: number,
  b: LineSource,
  bStart: number,
  bEnd: number,
): boolean {
  const aIds = a.ids;
  const bIds = b.ids;
  if (aEnd - aStart <= bEnd - bStart) {
    const seen = new Set<number>();
    for (let index = aStart; index < aEnd; index += 1) seen.add(aIds[index]);
    for (let index = bStart; index < bEnd; index += 1) {
      if (seen.has(bIds[index])) return true;
    }
  } else {
    const seen = new Set<number>();
    for (let index = bStart; index < bEnd; index += 1) seen.add(bIds[index]);
    for (let index = aStart; index < aEnd; index += 1) {
      if (seen.has(aIds[index])) return true;
    }
  }
  return false;
}

// 递归分治。每层先剥掉公共前后缀，再用中间蛇把剩余区间一分为二。
// 复杂度：时间 O((N+M)D)，空间 O(N+M)；全不同时时间退化为 O((N+M)^2) 但内存仍线性。
function diffRange(
  a: LineSource,
  aStart: number,
  aEnd: number,
  b: LineSource,
  bStart: number,
  bEnd: number,
  ops: Op[],
): void {
  const aIds = a.ids;
  const bIds = b.ids;
  // 公共前缀
  while (aStart < aEnd && bStart < bEnd && aIds[aStart] === bIds[bStart]) {
    ops.push({ kind: 'equal', text: a.texts[aStart] });
    aStart += 1;
    bStart += 1;
  }

  // 公共后缀，留到递归结束后再输出
  let suffix = 0;
  while (aStart < aEnd && bStart < bEnd && aIds[aEnd - 1] === bIds[bEnd - 1]) {
    aEnd -= 1;
    bEnd -= 1;
    suffix += 1;
  }

  if (aStart === aEnd) {
    for (let index = bStart; index < bEnd; index += 1) {
      ops.push({ kind: 'insert', text: b.texts[index] });
    }
  } else if (bStart === bEnd) {
    for (let index = aStart; index < aEnd; index += 1) {
      ops.push({ kind: 'delete', text: a.texts[index] });
    }
  } else if (!hasCommonLine(a, aStart, aEnd, b, bStart, bEnd)) {
    // 剥掉公共前后缀后仍没有任何一行相同：没有可显示的细粒度差异，
    // 最优解就是把旧区间全部删除、新区间全部新增。O(N+M)，瞬间完成。
    for (let index = aStart; index < aEnd; index += 1) {
      ops.push({ kind: 'delete', text: a.texts[index] });
    }
    for (let index = bStart; index < bEnd; index += 1) {
      ops.push({ kind: 'insert', text: b.texts[index] });
    }
  } else if (aEnd - aStart > LARGE_FILE_LIMIT && bEnd - bStart > LARGE_FILE_LIMIT) {
    // 首尾公共部分已经剥掉，中间还各有 2 万行以上：全删全增，不再差分。
    for (let index = aStart; index < aEnd; index += 1) {
      ops.push({ kind: 'delete', text: a.texts[index] });
    }
    for (let index = bStart; index < bEnd; index += 1) {
      ops.push({ kind: 'insert', text: b.texts[index] });
    }
  } else {
    const snake = findMiddleSnake(a, aStart, aEnd, b, bStart, bEnd);
    if (
      !snake ||
      (snake.x === aStart && snake.y === bStart) ||
      (snake.x === aEnd && snake.y === bEnd)
    ) {
      // 理论上不会走到这里；兜底成一次替换，保证一定前进、不会死循环。
      for (let index = aStart; index < aEnd; index += 1) {
        ops.push({ kind: 'delete', text: a.texts[index] });
      }
      for (let index = bStart; index < bEnd; index += 1) {
        ops.push({ kind: 'insert', text: b.texts[index] });
      }
    } else {
      diffRange(a, aStart, snake.x, b, bStart, snake.y, ops);
      diffRange(a, snake.x, aEnd, b, snake.y, bEnd, ops);
    }
  }

  for (let index = aEnd; index < aEnd + suffix; index += 1) {
    ops.push({ kind: 'equal', text: a.texts[index] });
  }
}

function diffLines(oldLines: string[], newLines: string[]): Op[] {
  // 同一张表给两侧编号，id 相同即内容相同。
  const ids = new Map<string, number>();
  const toSource = (lines: string[]): LineSource => {
    const lineIds = new Int32Array(lines.length);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      let id = ids.get(line);
      if (id === undefined) {
        id = ids.size;
        ids.set(line, id);
      }
      lineIds[index] = id;
    }
    return { ids: lineIds, texts: lines };
  };

  const oldSource = toSource(oldLines);
  const newSource = toSource(newLines);
  const ops: Op[] = [];
  diffRange(oldSource, 0, oldSource.ids.length, newSource, 0, newSource.ids.length, ops);
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

  // git 生成的 patch 末尾带换行
  return [`--- ${oldName}`, `+++ ${newName}`, ...hunks].join('\n') + '\n';
}
