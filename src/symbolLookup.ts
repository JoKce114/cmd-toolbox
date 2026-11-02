import type { EditorState } from '@codemirror/state';
import type { SymbolLookupResult, SymbolMatch } from './types';

const WORD_CHAR = /[\w$]/;

// 光标可能落在词中间，也可能刚点在词尾：向右补一次，向左退一步再匹配
export function wordAndReceiverAt(
  state: EditorState,
  pos: number,
): { name: string; receiver: string; from: number; to: number } | null {
  const line = state.doc.lineAt(pos);
  const text = line.text;
  const column = pos - line.from;

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

  return { name, receiver, from: line.from + start, to: line.from + end };
}

export async function lookupSymbol(
  projectPath: string,
  name: string,
  options: { currentPath?: string; receiver?: string },
): Promise<SymbolLookupResult> {
  const bridge = window.api?.symbols;
  if (!bridge) return { ok: false, matches: [], truncated: false, scanned: 0 };
  try {
    return await bridge.lookup(projectPath, name, options);
  } catch {
    return { ok: false, matches: [], truncated: false, scanned: 0 };
  }
}

export function describeLocation(match: SymbolMatch): string {
  const file = match.relPath.split('/').pop() || match.relPath;
  const owner = match.owner ? `${match.owner}::` : '';
  return `${owner}${match.name} · ${file}:${match.line}`;
}
