// 应用内更新公告直接显示 GitHub Release 的正文，而正文是 Markdown。
// 这里只解析更新说明实际会用到的几种语法，不走完整的 Markdown 渲染，
// 避免为一个弹窗引入依赖。
export type NoteBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'subheading'; text: string }
  | { kind: 'bullet'; depth: number; text: string }
  | { kind: 'paragraph'; text: string };

const VERSION_HEADING = /^##\s*\[?\s*v?\d+\.\d+/;
const RULE = /^-{3,}$/;

export function parseReleaseNotes(raw: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  const lines = String(raw || '')
    .replace(/\r\n/g, '\n')
    .split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (RULE.test(trimmed)) continue;
    // 弹窗标题已经显示版本号，正文里的「## [1.4.0] - 日期」再画一遍是重复的
    if (VERSION_HEADING.test(trimmed)) continue;

    if (trimmed.startsWith('#### ')) {
      blocks.push({ kind: 'subheading', text: trimmed.slice(5).trim() });
      continue;
    }
    if (trimmed.startsWith('### ')) {
      blocks.push({ kind: 'heading', text: trimmed.slice(4).trim() });
      continue;
    }
    if (trimmed.startsWith('## ')) {
      blocks.push({ kind: 'heading', text: trimmed.slice(3).trim() });
      continue;
    }

    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({
        kind: 'bullet',
        depth: bullet[1].length >= 2 ? 1 : 0,
        text: bullet[2].trim(),
      });
      continue;
    }

    // 独占一行的 **加粗** 当作小标题用
    const bold = /^\*\*(.+)\*\*$/.exec(trimmed);
    if (bold && !bold[1].includes('**')) {
      blocks.push({ kind: 'subheading', text: bold[1].trim() });
      continue;
    }

    blocks.push({ kind: 'paragraph', text: trimmed });
  }

  return blocks;
}

// 行内只处理 **加粗** 和 `代码`
export type InlineToken = { kind: 'text' | 'strong' | 'code'; value: string };

export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ kind: 'text', value: text.slice(lastIndex, match.index) });
    }
    const raw = match[0];
    if (raw.startsWith('**')) {
      tokens.push({ kind: 'strong', value: raw.slice(2, -2) });
    } else {
      tokens.push({ kind: 'code', value: raw.slice(1, -1) });
    }
    lastIndex = match.index + raw.length;
  }

  if (lastIndex < text.length) {
    tokens.push({ kind: 'text', value: text.slice(lastIndex) });
  }
  return tokens;
}
