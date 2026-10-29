import type { ChangeSpec, EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

type BlockTokens = { open: string; close: string };
type CommentTokens = { line?: string; block?: BlockTokens };

type LineTarget = {
  from: number;
  indent: number;
  text: string;
  lineToken?: string;
  block?: BlockTokens;
};

// 注释语法按每一行自身的语言区域取：PHP 段用 //，HTML 段用 <!-- -->。
// 内置 toggleComment 只按选区首行决定，混排文件里会给 HTML 行加上 //。
function tokensAt(state: EditorState, pos: number): CommentTokens {
  const data = state.languageDataAt<CommentTokens>('commentTokens', pos, 1);
  return data.length ? data[0] : {};
}

function collectTargets(state: EditorState): LineTarget[] {
  const seen = new Set<number>();
  const targets: LineTarget[] = [];

  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from);
    let last = state.doc.lineAt(range.to);
    // 选区结束在下一行行首时，那一行不算被选中
    if (last.number > first.number && range.to === last.from) {
      last = state.doc.line(last.number - 1);
    }
    for (let number = first.number; number <= last.number; number += 1) {
      const line = state.doc.line(number);
      if (seen.has(line.from)) continue;
      seen.add(line.from);

      const indent = /^[ \t]*/.exec(line.text)![0].length;
      // 跳过已有的注释标记再判断语言区域，否则「// <?php」这样的已注释行
      // 会因为在行首看不到 <?php 而被误判成 HTML
      const probe = Math.min(line.from + indent + contentOffset(line.text.slice(indent)), line.to);
      const tokens = tokensAt(state, probe);
      if (!tokens.line && !tokens.block) continue;

      targets.push({
        from: line.from,
        indent,
        text: line.text,
        lineToken: tokens.line,
        block: tokens.block,
      });
    }
  }
  return targets;
}

const LEADING_MARKERS = ['//', '/*', '<!--'];

function contentOffset(body: string): number {
  for (const marker of LEADING_MARKERS) {
    if (body.startsWith(marker)) {
      const after = marker.length;
      return body.charAt(after) === ' ' ? after + 1 : after;
    }
  }
  return 0;
}

function bodyOf(target: LineTarget): string {
  return target.text.slice(target.indent);
}

function isCommented(target: LineTarget): boolean {
  const body = bodyOf(target);
  if (!body) return false;
  if (target.lineToken) return body.startsWith(target.lineToken);
  const block = target.block;
  if (!block) return false;
  return (
    body.length >= block.open.length + block.close.length &&
    body.startsWith(block.open) &&
    body.endsWith(block.close)
  );
}

function commentChanges(target: LineTarget): ChangeSpec[] {
  const body = bodyOf(target);
  if (!body) {
    // 空行只有行注释语法有地方落脚，块注释直接跳过
    return target.lineToken ? [{ from: target.from + target.indent, insert: `${target.lineToken} ` }] : [];
  }
  if (target.lineToken) {
    return [{ from: target.from + target.indent, insert: `${target.lineToken} ` }];
  }
  const block = target.block!;
  const contentEnd = target.from + target.text.trimEnd().length;
  return [
    { from: target.from + target.indent, insert: `${block.open} ` },
    { from: contentEnd, insert: ` ${block.close}` },
  ];
}

function uncommentChanges(target: LineTarget): ChangeSpec[] {
  if (target.lineToken) {
    const start = target.from + target.indent;
    let end = start + target.lineToken.length;
    if (target.text.charAt(end - target.from) === ' ') end += 1;
    return [{ from: start, to: end }];
  }

  const block = target.block!;
  const start = target.from + target.indent;
  const contentEnd = target.from + target.text.trimEnd().length;
  let openEnd = start + block.open.length;
  if (target.text.charAt(openEnd - target.from) === ' ') openEnd += 1;
  let closeStart = contentEnd - block.close.length;
  if (target.text.charAt(closeStart - target.from - 1) === ' ') closeStart -= 1;
  // 空注释（如 <!-- -->）时两侧去掉范围会重叠，收敛到同一个位置
  if (closeStart < openEnd) closeStart = openEnd;
  return [
    { from: start, to: openEnd },
    { from: closeStart, to: contentEnd },
  ];
}

export function toggleLineComment(view: EditorView): boolean {
  const { state } = view;
  const targets = collectTargets(state);
  if (!targets.length) return false;

  const uncomment =
    targets.some((target) => bodyOf(target)) &&
    targets.every((target) => !bodyOf(target) || isCommented(target));

  const changes: ChangeSpec[] = [];
  for (const target of targets) {
    if (uncomment) {
      if (bodyOf(target)) changes.push(...uncommentChanges(target));
    } else {
      changes.push(...commentChanges(target));
    }
  }
  if (!changes.length) return false;

  view.dispatch({
    changes,
    userEvent: uncomment ? 'delete.comment' : 'input.comment',
  });
  return true;
}
