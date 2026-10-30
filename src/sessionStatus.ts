export type ModelStatus = 'idle' | 'waiting' | 'running' | 'error';

// AI 在等一个慢命令时可能十几秒不出一个字节，阈值太短会把「还在跑」误判成「已完成」。
export const IDLE_RESET_MS = 15000;

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
