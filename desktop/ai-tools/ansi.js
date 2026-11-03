// pty 输出里混着 CSI/OSC 控制序列与回车重绘（进度条会反复覆盖同一行）。
// AI 拿到的必须是清理后的文本，否则只能读到一堆转义码。
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OTHER_ESCAPES = /\x1b[@-_]/g;

function stripAnsi(raw) {
  return String(raw || '')
    .replace(OSC, '')
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
  const lines = text.split('\n').map((line) => applyLineEdits(line).replace(/\s+$/, ''));
  const collapsed = [];
  for (const line of lines) {
    if (line === '' && collapsed.length && collapsed[collapsed.length - 1] === '') continue;
    collapsed.push(line);
  }
  while (collapsed.length && collapsed[collapsed.length - 1] === '') collapsed.pop();
  return collapsed.join('\n');
}

module.exports = { cleanOutput, stripAnsi };
