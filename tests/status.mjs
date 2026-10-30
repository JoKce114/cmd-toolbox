let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

function stripAnsi(value) {
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b./g, '');
}

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

function classify(value) {
  const tail = stripAnsi(value).slice(-1500);
  if (WAITING_PATTERNS.some((pattern) => pattern.test(tail))) return 'waiting';
  if (ERROR_PATTERNS.some((pattern) => pattern.test(tail))) return 'error';
  return 'running';
}

function rollup(values) {
  const rank = { error: 3, waiting: 2, running: 1, idle: 0 };
  let best = 'idle';
  for (const value of values) {
    if (rank[value] > rank[best]) best = value;
  }
  return best;
}

// 与 src/sessionStatus.ts 的 transitionUnread 保持一致
function transitionUnread(previous, next, watched) {
  if (next === 'idle' || next === 'error') {
    const wasBusy = previous === 'running' || previous === 'waiting';
    return wasBusy && !watched ? 'set-unread' : 'none';
  }
  return 'clear-unread';
}

assert(classify('Waiting for approval') === 'waiting', '等待确认');
assert(classify('Error: boom') === 'error', '报错');
assert(classify('\u001b[31mError: boom') === 'error', '带颜色的报错');
assert(classify('thinking about the code') === 'running', '回答中');
assert(rollup(['idle', 'running', 'waiting']) === 'waiting', '等待优先于回答');
assert(rollup(['waiting', 'error']) === 'error', '报错优先');
assert(rollup([]) === 'idle', '没有模型就是空闲');

assert(
  transitionUnread('running', 'idle', false) === 'set-unread',
  '跑完且没在看 → 标记未读',
);
assert(
  transitionUnread('running', 'idle', true) === 'none',
  '跑完时正在看 → 不标记未读',
);
assert(
  transitionUnread('error', 'idle', false) === 'none',
  '报错后回落空闲不重复标记',
);
assert(
  transitionUnread('waiting', 'error', false) === 'set-unread',
  '等待确认后报错 → 标记未读',
);
assert(
  transitionUnread('idle', 'running', false) === 'clear-unread',
  '重新开始跑 → 清除未读',
);
assert(
  transitionUnread(undefined, 'running', false) === 'clear-unread',
  '首次输出不产生未读',
);

console.log(`status ${passed} passed`);
