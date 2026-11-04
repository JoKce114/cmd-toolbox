import { diffLines, splitLinesForDiff } from './diffFromText';
import type { DiffOp } from './diffFromText';

export type LineChangeKind = 'added' | 'modified';

export type ChangeChunk = {
  startLine: number;
  endLine: number;
  kind: LineChangeKind;
};

export type DeleteAnchor = {
  line: number;
  texts: string[];
};

export type LineChanges = {
  chunks: ChangeChunk[];
  addedLines: number[];
  modifiedLines: number[];
  deletes: DeleteAnchor[];
  totalLines: number;
};

// 与 diffFromText 的大文件兜底同量级：标记只是辅助信息，
// 不值得为超大文件付出逐行装饰的成本。
const MARKER_LINE_LIMIT = 20000;

function empty(totalLines: number): LineChanges {
  return { chunks: [], addedLines: [], modifiedLines: [], deletes: [], totalLines };
}

export function computeLineChanges(oldText: string, newText: string): LineChanges {
  const oldLines = splitLinesForDiff(oldText);
  const newLines = splitLinesForDiff(newText);
  const totalLines = Math.max(1, newLines.length);

  if (oldLines.join('\n') === newLines.join('\n')) return empty(totalLines);
  if (oldLines.length + newLines.length > MARKER_LINE_LIMIT) return empty(totalLines);

  const ops: DiffOp[] = diffLines(oldLines, newLines);
  const clamp = (line: number) => Math.min(Math.max(1, line), totalLines);

  const changes = empty(totalLines);
  let newLine = 1;
  let index = 0;

  while (index < ops.length) {
    if (ops[index].kind === 'equal') {
      newLine += 1;
      index += 1;
      continue;
    }

    const blockStart = newLine;
    const deleted: string[] = [];
    let inserts = 0;
    while (index < ops.length && ops[index].kind !== 'equal') {
      if (ops[index].kind === 'delete') {
        deleted.push(ops[index].text);
      } else {
        inserts += 1;
        newLine += 1;
      }
      index += 1;
    }

    if (inserts > 0) {
      // 删 d 行插 i 行时，前 min(d, i) 行算「修改」，多出来的算「新增」
      const modifiedCount = Math.min(deleted.length, inserts);
      if (modifiedCount > 0) {
        changes.chunks.push({
          startLine: blockStart,
          endLine: blockStart + modifiedCount - 1,
          kind: 'modified',
        });
        for (let line = blockStart; line < blockStart + modifiedCount; line += 1) {
          changes.modifiedLines.push(line);
        }
      }
      if (inserts > modifiedCount) {
        const from = blockStart + modifiedCount;
        changes.chunks.push({ startLine: from, endLine: blockStart + inserts - 1, kind: 'added' });
        for (let line = from; line < blockStart + inserts; line += 1) {
          changes.addedLines.push(line);
        }
      }
    }

    if (deleted.length > 0) {
      // 块产生了新行就锚在块首行；纯删除锚在删除位置之后那一行
      changes.deletes.push({
        line: clamp(inserts > 0 ? blockStart : newLine),
        texts: deleted,
      });
    }
  }

  return changes;
}
