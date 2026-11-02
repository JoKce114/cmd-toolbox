import type { EditorState } from '@codemirror/state';
import type { SymbolLookupResult, SymbolMatch } from './types';

const WORD_CHAR = /[\w$]/;

// 光标可能落在词中间，也可能刚点在词尾：向右补一次，向左退一步再匹配
export function wordAndReceiverAt(
  state: EditorState,
  pos: number,
): { name: string; receiver: string; from: number; to: number; line: number } | null {
  // 调用方可能给出越界位置（例如文档刚被替换），先夹到合法区间再取行
  const safePos = Math.max(0, Math.min(pos, state.doc.length));
  const line = state.doc.lineAt(safePos);
  const text = line.text;
  const column = safePos - line.from;

  let start = column;
  let end = column;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start -= 1;
  while (end < text.length && WORD_CHAR.test(text[end])) end += 1;
  if (start === end) return null;

  const name = text.slice(start, end);
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;

  // Foo::bar() / $obj->bar()：取名字前面那段标识符当「接收者」
  const before = text.slice(0, start);
  const match = /([A-Za-z_][\w]*)\s*(?:::|->)\s*$/.exec(before);
  const receiver = match ? match[1] : '';

  return { name, receiver, from: line.from + start, to: line.from + end, line: line.number };
}

export async function lookupSymbol(
  projectPath: string,
  name: string,
  options: { currentPath?: string; receiver?: string; line?: number },
): Promise<SymbolLookupResult> {
  const bridge = window.api?.symbols;
  if (!bridge) return { ok: false, failed: true, matches: [], truncated: false, scanned: 0 };
  try {
    return await bridge.lookup(projectPath, name, options);
  } catch {
    return { ok: false, failed: true, matches: [], truncated: false, scanned: 0 };
  }
}

export function describeLocation(match: SymbolMatch): string {
  const file = match.relPath.split('/').pop() || match.relPath;
  const owner = match.owner ? `${match.owner}::` : '';
  return `${owner}${match.name} · ${file}:${match.line}`;
}
