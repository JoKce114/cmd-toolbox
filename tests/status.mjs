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

// 与 src/sessionStatus.ts 的 visibleSignature / endsWithPrompt 保持一致
const SPINNER_FRAMES = /[⠁⠂⠄⡀⢀⠠⠐⠈⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g;
const ELAPSED_TOKEN = /\b\d+(?:\.\d+)?s\b/g;

function signature(value) {
  return stripAnsi(value)
    .replace(/\r\n?/g, '\n')
    .replace(SPINNER_FRAMES, '')
    .replace(ELAPSED_TOKEN, '#s')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .join('\n');
}

function endsWithTurnDone(value) {
  const lines = signature(value).split('\n');
  const last = lines.length - 1;
  if (/Worked for\b|·\s*done\b/i.test(lines[last])) return true;
  if (!/^(?:>|❯|›|»)\s*$/.test(lines[last])) return false;
  return lines.slice(Math.max(0, last - 3), last).some((line) => /Worked for\b|·\s*done\b/i.test(line));
}

assert(
  signature('回答\n\n> ') === signature('回答\n>'),
  '光标闪烁与空行重绘不算新活动',
);
assert(
  signature('Worked for 42s\n> ') === signature('Worked for 43s\n>'),
  '耗时计数递增不算新活动',
);
assert(
  signature('⠙ 思考中') === signature('⠹ 思考中'),
  'spinner 转帧不算新活动',
);
assert(
  signature('Worked for 42s') !== signature('Worked for 42s\n新的回答'),
  '真的来了新文本要算新活动',
);
assert(endsWithTurnDone('回答\nWorked for 42s\n> ') === true, 'Worked for + 提示符 = 这一轮结束');
assert(endsWithTurnDone('回答\nWorked for 42s') === true, '只有 Worked for 也算结束');
assert(
  endsWithTurnDone('● ok\n✻ Baked for 1s · done 11:41\n────\n❯ ') === true,
  'Claude Code 的「· done」隔着分隔线也认',
);
assert(endsWithTurnDone('回答\n> ') === false, '光是提示符可见不算结束');
assert(endsWithTurnDone('Thought for 5.2s\n> ') === false, '思考阶段不算结束');
assert(
  endsWithTurnDone('Worked for 42s\n❯ 新问题已经发出去了') === false,
  '末尾是用户新输入的内容不算结束',
);
assert(endsWithTurnDone('') === false, '空输出不算结束');

console.log(`status ${passed} passed`);
