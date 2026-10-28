export type ConflictBlock = {
  startLine: number;
  separatorLine: number;
  endLine: number;
  baseLine: number | null;
  oursLabel: string;
  theirsLabel: string;
};

export type ConflictChoice = 'ours' | 'theirs' | 'both';

export type ConflictEdit = {
  from: number;
  to: number;
  insert: string;
};

const MARKER = {
  start: '<<<<<<<',
  base: '|||||||',
  separator: '=======',
  end: '>>>>>>>',
};

function labelOf(line: string, marker: string): string {
  return line.slice(marker.length).trim();
}

// 扫描整篇文本。任何一个块缺少结束标记就整体放弃，避免错误改写。
export function parseConflicts(text: string): ConflictBlock[] {
  const lines = text.split('\n');
  const blocks: ConflictBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].startsWith(MARKER.start)) {
      index += 1;
      continue;
    }

    const startLine = index;
    const oursLabel = labelOf(lines[index], MARKER.start);
    let cursor = index + 1;
    let baseLine: number | null = null;
    let separatorLine = -1;

    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.startsWith(MARKER.end)) break;
      if (line.startsWith(MARKER.base) && separatorLine < 0 && baseLine === null) {
        baseLine = cursor;
      } else if (line.startsWith(MARKER.separator) && separatorLine < 0) {
        separatorLine = cursor;
      } else if (line.startsWith(MARKER.start)) {
        // 嵌套开始标记说明结构已乱，整体放弃
        return [];
      }
      cursor += 1;
    }

    if (cursor >= lines.length) return [];
    if (separatorLine < 0) return [];
    if (baseLine !== null && baseLine > separatorLine) return [];

    blocks.push({
      startLine,
      separatorLine,
      endLine: cursor,
      baseLine,
      oursLabel,
      theirsLabel: labelOf(lines[cursor], MARKER.end),
    });

    index = cursor + 1;
  }

  return blocks;
}

// 把块内的三个区段按选择拼成替换文本；行号换算成字符偏移。
export function resolveConflict(
  text: string,
  block: ConflictBlock,
  choice: ConflictChoice,
): ConflictEdit | null {
  const lines = text.split('\n');
  if (block.endLine >= lines.length || block.separatorLine >= lines.length) return null;

  const oursEnd = block.baseLine ?? block.separatorLine;
  const ours = lines.slice(block.startLine + 1, oursEnd);
  const theirs = lines.slice(block.separatorLine + 1, block.endLine);

  let insert: string;
  if (choice === 'ours') insert = ours.join('\n');
  else if (choice === 'theirs') insert = theirs.join('\n');
  else insert = [...ours, ...theirs].join('\n');

  const from = offsetOfLine(lines, block.startLine);
  // 替换范围覆盖整块以及其后的换行；换行已被一起替换，插入内容需补回。
  const to = block.endLine + 1 >= lines.length
    ? text.length
    : offsetOfLine(lines, block.endLine + 1);
  if (to > from && block.endLine + 1 < lines.length) insert += '\n';

  return { from, to, insert };
}

function offsetOfLine(lines: string[], lineIndex: number): number {
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) {
    offset += lines[index].length + 1;
  }
  return offset;
}
