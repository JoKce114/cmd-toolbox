export type ModelStatus = 'idle' | 'waiting' | 'running' | 'error';

// AI 在等一个慢命令时可能十几秒不出一个字节，阈值太短会把「还在跑」误判成「已完成」。
export const IDLE_RESET_MS = 15000;

// CLI 自己打出「Worked for …s」并把提示符交回来时，这一轮确实结束了，不必再等满 15 秒。
export const TURN_DONE_IDLE_MS = 3000;

export type StatusTransition = 'set-unread' | 'clear-unread' | 'none';

// 任务从忙碌落到空闲或报错、且用户当时没在看这个页签 → 标记未读。
export function transitionUnread(
  previous: ModelStatus | undefined,
  next: ModelStatus,
  watched: boolean,
): StatusTransition {
  if (next === 'idle' || next === 'error') {
    const wasBusy = previous === 'running' || previous === 'waiting';
    return wasBusy && !watched ? 'set-unread' : 'none';
  }
  return 'clear-unread';
}

export const MODEL_STATUS_LABEL: Record<ModelStatus, string> = {
  idle: '暂时没有对话',
  waiting: '等待确认',
  running: '回答中',
  error: '报错',
};

const WAITING_PATTERNS = [
  /waiting for (your )?(approval|confirm|confirmation|permission)/i,
  /needs? (your )?(approval|permission|confirm)/i,
  /pending approval/i,
  /allow (this|the)? ?(command|tool|edit|once|always)/i,
  /always allow/i,
  /do you want to (proceed|continue|run|allow)/i,
  /\[y\/n\]/i,
  /\byes\s*\/\s*no\b/i,
  /press (enter|y) to (confirm|continue|approve)/i,
  /批准|等待确认|是否允许|允许这次/,
];

const ERROR_PATTERNS = [
  /^\s*(error|failed|failure|exception|panic)\b[:\s]/im,
  /\btraceback\b/i,
  /exited with code [1-9]/i,
  /报错|崩溃|执行失败/,
];

export function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b./g, '');
}

export function classifyModelOutput(value: string): ModelStatus {
  const tail = stripAnsi(value).slice(-1500);
  if (WAITING_PATTERNS.some((pattern) => pattern.test(tail))) return 'waiting';
  if (ERROR_PATTERNS.some((pattern) => pattern.test(tail))) return 'error';
  return 'running';
}

const SPINNER_FRAMES = /[⠁⠂⠄⡀⢀⠠⠐⠈⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g;
const ELAPSED_TOKEN = /\b\d+(?:\.\d+)?s\b/g;

// TUI 会重绘出纯控制序列、spinner 转帧和耗时计数，这些不是新内容，不该触发状态重算。
export function visibleSignature(value: string): string {
  return stripAnsi(value)
    .replace(/\r\n?/g, '\n')
    .replace(SPINNER_FRAMES, '')
    .replace(ELAPSED_TOKEN, '#s')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .join('\n');
}

const PROMPT_LINE = /^(?:>|❯|›|»)\s*$/;
// Grok 收尾打「Worked for 42s」，Claude Code 打「✻ Baked for 1s · done 11:41」。
// 不认「Thought for …s」——那是思考中的计时，认了会在思考阶段误判结束。
const TURN_DONE_LINE = /Worked for\b|·\s*done\b/i;

// 提示符和完成标记之间通常还夹着一条分隔线，所以往回多看几行。
// 只有末尾是提示符（或标记本身）时才算数，用户刚发出去的消息不会命中。
export function endsWithTurnDone(value: string): boolean {
  const lines = visibleSignature(value).split('\n');
  const last = lines.length - 1;
  if (TURN_DONE_LINE.test(lines[last])) return true;
  if (!PROMPT_LINE.test(lines[last])) return false;
  return lines.slice(Math.max(0, last - 3), last).some((line) => TURN_DONE_LINE.test(line));
}

export function rollupModelStatus(values: ModelStatus[]): ModelStatus {
  const rank: Record<ModelStatus, number> = {
    error: 3,
    waiting: 2,
    running: 1,
    idle: 0,
  };
  let best: ModelStatus = 'idle';
  for (const value of values) {
    if (rank[value] > rank[best]) best = value;
  }
  return best;
}
