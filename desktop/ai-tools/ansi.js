// pty 输出里混着 CSI/OSC 控制序列与回车重绘（进度条会反复覆盖同一行）。
// AI 拿到的必须是清理后的文本，否则只能读到一堆转义码。
const CSI = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// 没带终止符的 OSC（终端标题常被截断）也要从行内剥掉，否则会留下 "0;title"。
const OSC_UNTERMINATED = /\x1b\][^\x07\x1b\n]*/g;
// ESC 后可能跟中间字节再跟终止字节，例如字符集切换 \x1b(B。
const OTHER_ESCAPES = /\x1b[ -/]*[@-~]/g;

function stripAnsi(raw) {
  return String(raw || '')
    .replace(OSC, '')
    .replace(OSC_UNTERMINATED, '')
    .replace(CSI, '')
    .replace(OTHER_ESCAPES, '');
}

// 回车表示回到行首重写，退格表示删除前一个字符。逐行处理，
// 不做跨行的光标移动解析——那需要完整终端模拟，收益远小于成本。
function applyLineEdits(line) {
  let out = '';
  for (const char of line) {
    if (char === '\r') {
      out = '';
      continue;
    }
    if (char === '\b') {
      out = out.slice(0, -1);
      continue;
    }
    out += char;
  }
  return out;
}

function cleanOutput(raw) {
  const text = stripAnsi(raw);
  if (!text) return '';
  // Windows 的 pty（ConPTY）换行是 CRLF。必须先归一成 LF，否则行尾的 \r
  // 会被当成回到行首，把整行清空。单独出现的 \r 仍保留覆盖语义。
  const normalized = text.replace(/\r+\n/g, '\n');
  const lines = normalized.split('\n').map((line) => applyLineEdits(line).replace(/\s+$/, ''));
  const collapsed = [];
  for (const line of lines) {
    if (line === '' && collapsed.length && collapsed[collapsed.length - 1] === '') continue;
    collapsed.push(line);
  }
  while (collapsed.length && collapsed[collapsed.length - 1] === '') collapsed.pop();
  return collapsed.join('\n');
}

module.exports = { cleanOutput, stripAnsi };
