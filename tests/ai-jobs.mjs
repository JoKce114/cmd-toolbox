import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jobs = require('../desktop/ai-tools/jobs.js');

let passed = 0;
const assert = (cond, msg) => {
  if (!cond) throw new Error(`断言失败：${msg}`);
  passed += 1;
  console.log('  ok  ' + msg);
};

const SESSION_ID = 'session-1';
const PANE = {
  id: 'tab-1',
  paneNo: 3,
  kind: 'terminal',
  sessionId: SESSION_ID,
  aiOwned: true,
  groupKey: 'grp-a',
  groupName: 'Demo',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 假 pty：buffer 里的偏移是单调递增的绝对偏移。
// getOutputSlice 按 pty-host 的契约返回一段切片：text 的首字符对应 startOffset。
let buffer = '';
// buffer[0] 的绝对偏移。模拟 pty-host 的尾部缓冲：追加超过 bufferCap 时旧内容前移。
let bufferStart = 0;
let bufferCap = Infinity;
const bufferEnd = () => bufferStart + buffer.length;
function appendOutput(text) {
  buffer += text;
  if (buffer.length > bufferCap) {
    const excess = buffer.length - bufferCap;
    buffer = buffer.slice(-bufferCap);
    bufferStart += excess;
  }
}
const written = [];
const dataHandlers = new Set();
const exitHandlers = new Set();
const openSessions = new Set([SESSION_ID]);
const extraPanes = new Map();

function emitData(text) {
  appendOutput(text);
  // 处理器可能在回调里退订，先快照
  for (const handler of [...dataHandlers]) handler(SESSION_ID, text);
}

function emitExit(code, exitOutput) {
  const snapshot = exitOutput || {
    text: buffer,
    startOffset: bufferStart,
    endOffset: bufferEnd(),
    truncated: false,
  };
  for (const handler of [...exitHandlers]) handler(SESSION_ID, code, snapshot);
}

let findPaneImpl = (ref) => {
  if (ref === '#3' || ref === 'tab-1') return PANE;
  if (ref === '#conflict') {
    const error = new Error('页签编号 #9 在多个项目里重号，请改用 tabId');
    error.status = 409;
    throw error;
  }
  return extraPanes.get(ref) || null;
};

jobs.configure({
  writeSession: (sessionId, data) => {
    written.push({ sessionId, data });
  },
  getOutputSlice: (sessionId, fromOffset) => {
    if (sessionId !== SESSION_ID) {
      return { text: '', startOffset: 0, endOffset: 0, truncated: false };
    }
    const endOffset = bufferEnd();
    const requested = Number(fromOffset);
    const requestedOffset = Number.isFinite(requested) ? Math.floor(requested) : bufferStart;
    // 与 pty-host.getOutputSlice 相同：请求早于缓冲区起点时从起点开始并标记 truncated
    const from = Math.max(requestedOffset, bufferStart);
    return {
      text: from <= endOffset ? buffer.slice(from - bufferStart) : '',
      startOffset: from,
      endOffset,
      truncated: requestedOffset < bufferStart,
    };
  },
  isOpen: (sessionId) => openSessions.has(sessionId),
  findPane: (ref) => findPaneImpl(ref),
  panes: () => [PANE],
  subscribeData: (handler) => {
    dataHandlers.add(handler);
    return () => dataHandlers.delete(handler);
  },
  subscribeExit: (handler) => {
    exitHandlers.add(handler);
    return () => exitHandlers.delete(handler);
  },
});

// 错误码断言：thunk 兼容同步抛错（job_output / terminal_send）和 Promise 拒绝（terminal_run）。
async function expectCode(fn, code, msg) {
  let actual = null;
  try {
    await fn();
  } catch (error) {
    actual = error && error.code;
  }
  assert(actual === code, `${msg}（实际 ${actual === null ? '没有报错' : actual}）`);
}

const lastWrite = () => written[written.length - 1];

console.log('1. 命令写入 pty（trim 后带回车）并安静返回 idle');
written.length = 0;
const run1 = jobs.call('terminal_run', { command: '  echo hi  ', pane: '#3', quietMs: 30 });
assert(written.length === 1, 'terminal_run 只向 pty 写一次');
assert(lastWrite().sessionId === SESSION_ID, '写入目标是 pane 的 sessionId');
assert(lastWrite().data === 'echo hi\r', '命令被 trim 并补上回车');
setTimeout(() => emitData('hi there\r\n'), 5);
const result1 = await run1;
assert(result1.status === 'idle', '无退出、安静后返回 idle');
assert(result1.pane === '#3', '返回窗格编号');
assert(typeof result1.jobId === 'string' && result1.jobId.length > 0, '返回非空 jobId');
assert(result1.output.includes('hi there'), 'idle 回包带上本次命令的输出');
assert(typeof result1.cursor === 'number' && result1.cursor > 0, 'idle 回包带上绝对 cursor');

console.log('2. 输出持续期间不结算（data 会重新计时 quiet）');
// 每次 data 到达都应把 quiet 定时器往后推。若 subscribeData 只是收下了回调
// 而不重新计时，下面的任务会在第一次 armQuiet 起的 100ms 就返回。
const streamStart = Date.now();
const runStreaming = jobs.call('terminal_run', {
  command: 'stream',
  pane: '#3',
  quietMs: 100,
});
for (const at of [0, 50, 100, 150]) {
  const wait = at - (Date.now() - streamStart);
  if (wait > 0) await sleep(wait);
  emitData(`chunk-${at}\r\n`);
}
const streamResult = await runStreaming;
const streamElapsed = Date.now() - streamStart;
assert(streamResult.status === 'idle', '持续输出结束后安静即返回 idle');
assert(
  streamElapsed >= 230,
  `最后一次输出后还要等满 quietMs 才返回（实测 ${streamElapsed}ms，首次计时会约 100ms）`,
);
assert(streamResult.output.includes('chunk-150'), '回包包含最后一次推送的输出');

console.log('3. 进程退出返回 done 与真实退出码');
const beforeExit = bufferEnd();
const run2 = jobs.call('terminal_run', { command: 'ls', pane: '#3', quietMs: 5000 });
await sleep(5);
emitData('file-a.txt\r\nfile-b.txt\r\n');
emitExit(3);
const result2 = await run2;
assert(result2.status === 'done', '退出返回 done');
assert(result2.exitCode === 3, '退出码原样带回（不是缺省的 0）');
assert(result2.output.includes('file-a.txt'), 'done 回包包含退出前的输出');
assert(result2.cursor > beforeExit, 'done 回包的 cursor 前进了');

console.log('4. 同一 session 并发被拒绝（pane-busy）');
const busyJob = jobs.call('terminal_run', {
  command: 'long-task',
  pane: '#3',
  quietMs: 5000,
  timeoutMs: 6000,
});
await sleep(5);
await expectCode(
  () => jobs.call('terminal_run', { command: 'second', pane: '#3' }),
  'pane-busy',
  '同 session 的第二个 terminal_run 返回 pane-busy',
);
await expectCode(
  () => jobs.call('terminal_send', { pane: '#3', text: 'x' }),
  'pane-busy',
  'terminal_send 受同一条占用约束',
);
emitExit(0);
const busyResult = await busyJob;
assert(busyResult.status === 'done', '占用方退出后正常结算');

console.log('5. 空命令被拒绝');
written.length = 0;
await expectCode(
  () => jobs.call('terminal_run', { command: '   ', pane: '#3' }),
  'bad-request',
  '空白 command 返回 bad-request',
);
assert(written.length === 0, '被拒绝的命令没有写进 pty');
await expectCode(
  () => jobs.call('terminal_run', { pane: '#3' }),
  'bad-request',
  '缺少 command 也返回 bad-request',
);

console.log('6. timeoutMs 超过 10 分钟被拒绝');
await expectCode(
  () => jobs.call('terminal_run', { command: 'x', pane: '#3', timeoutMs: 700000 }),
  'bad-request',
  'terminal_run 的 timeoutMs 超限返回 bad-request',
);
await expectCode(
  () => jobs.call('terminal_wait', { pane: '#3', pattern: 'ready', timeoutMs: 700000 }),
  'bad-request',
  'terminal_wait 的 timeoutMs 超限返回 bad-request',
);

console.log('7. job_output 增量 cursor 不重复');
const beforeIncrement = bufferEnd();
const runIncrement = jobs.call('terminal_run', { command: 'echo inc', pane: '#3', quietMs: 40 });
await sleep(5);
emitData('inc-one\r\n');
const resultIncrement = await runIncrement;
const incFirst = jobs.call('job_output', { jobId: resultIncrement.jobId, cursor: beforeIncrement });
assert(incFirst.output === 'inc-one', '从命令起点读到的正好是本次新增输出');
assert(incFirst.cursor > beforeIncrement, 'cursor 前进到新输出末尾');
const incSecond = jobs.call('job_output', { jobId: resultIncrement.jobId, cursor: incFirst.cursor });
assert(incSecond.output === '', 'cursor 之后没有新内容时不重复输出');
assert(incSecond.cursor === incFirst.cursor, '没有新内容时 cursor 保持不变');
const incOver = jobs.call('job_output', { jobId: resultIncrement.jobId, cursor: incFirst.cursor + 9999 });
assert(incOver.output === '', 'cursor 越界时读不到内容');
assert(incOver.cursor === incFirst.cursor + 9999, '越界 cursor 不回退');

console.log('8. terminal_wait 先匹配已有输出');
const waitMatched = await jobs.call('terminal_wait', {
  pane: '#3',
  pattern: 'inc-one',
  timeoutMs: 200,
});
assert(waitMatched.status === 'matched', '已有输出命中时立即返回 matched');
assert(waitMatched.match === 'inc-one', '带回命中的片段');
assert(waitMatched.pane === '#3', '带回窗格编号');

console.log('9. terminal_send 的 submit 语义');
written.length = 0;
const sentDefault = jobs.call('terminal_send', { pane: '#3', text: 'quit' });
assert(sentDefault.ok === true, 'terminal_send 返回 ok');
assert(lastWrite().data === 'quit\r', 'submit 默认补回车');
jobs.call('terminal_send', { pane: '#3', text: 'q', submit: false });
assert(lastWrite().data === 'q', 'submit:false 原样发送不补回车');

console.log('10. 路径与参数错误码');
await expectCode(
  () => jobs.call('terminal_run', { command: 'x', pane: '#999' }),
  'pane-not-found',
  '未知 pane 返回 pane-not-found',
);
extraPanes.set('#browser', { kind: 'browser', sessionId: 'browser-1', paneNo: 7 });
await expectCode(
  () => jobs.call('terminal_run', { command: 'x', pane: '#browser' }),
  'pane-not-found',
  '非终端窗格返回 pane-not-found',
);
extraPanes.set('#dead', { kind: 'terminal', sessionId: 'session-dead', paneNo: 9 });
await expectCode(
  () => jobs.call('terminal_run', { command: 'x', pane: '#dead' }),
  'pane-not-found',
  '会话已退出返回 pane-not-found',
);
await expectCode(
  () => jobs.call('terminal_run', { command: 'x', pane: '#conflict' }),
  'bad-request',
  'findPane 抛 409 时转成 bad-request',
);
await expectCode(
  () => jobs.call('terminal_send', { pane: '#999', text: 'x' }),
  'pane-not-found',
  'terminal_send 的未知 pane 返回 pane-not-found',
);
await expectCode(
  () => jobs.call('job_output', { jobId: 'no-such-job', cursor: 0 }),
  'pane-not-found',
  '未知 jobId 返回 pane-not-found',
);
await expectCode(
  () => jobs.call('terminal_wait', { pane: '#3', pattern: '' }),
  'bad-request',
  '空 pattern 返回 bad-request',
);
await expectCode(
  () => jobs.call('terminal_wait', { pane: '#3', pattern: '(' }),
  'bad-request',
  '非法正则返回 bad-request',
);

console.log('11. 总超时返回 running 且占用不释放');
// 这个用例验证的是「超时返回后占用不释放」。
// clampQuiet 会把 quietMs 截到不超过 timeoutMs，所以没法靠调大 quietMs 让
// quiet 定时器晚到；这里持续推 data，把 quiet 的重计时刻始终保持在超时之后，
// 这样 timeout 是确定性的胜出方，不依赖两个定时器同刻到期的先后顺序。
const feed = setInterval(() => emitData('.'), 5);
let timedResult;
try {
  timedResult = await jobs.call('terminal_run', {
    command: 'slow-task',
    pane: '#3',
    timeoutMs: 40,
    quietMs: 60000,
  });
} finally {
  clearInterval(feed);
}
assert(timedResult.status === 'running', '总超时返回 running');
assert(timedResult.exitCode === null, 'running 回包不带退出码');
assert(
  typeof timedResult.hint === 'string' && timedResult.hint.includes('terminal_interrupt'),
  'running 回包提示用 terminal_interrupt 中断',
);
await expectCode(
  () => jobs.call('terminal_run', { command: 'next', pane: '#3' }),
  'pane-busy',
  '超时回包后占用仍保留，下一条命令被拒绝',
);

// 占用期间直接放行任意 terminal_send 会把输入喂给正在跑的进程，输出仍被算进旧 job；
// 中断是唯一例外：它只让当前命令停下来，不产生新命令。
written.length = 0;
const interrupt = jobs.call('terminal_interrupt', { pane: '#3' });
assert(interrupt.ok === true, 'terminal_interrupt 在任务占用期间仍然允许');
assert(lastWrite().data === '\x03', '中断只写入 Ctrl+C，不补回车');
assert(interrupt.jobId === timedResult.jobId, '中断回包带上正在跑的 jobId');
await expectCode(
  () => jobs.call('terminal_interrupt', { pane: '#999' }),
  'pane-not-found',
  'terminal_interrupt 的未知 pane 返回 pane-not-found',
);

emitExit(0);
await sleep(5);
const afterRelease = await jobs.call('terminal_run', {
  command: 'after',
  pane: '#3',
  quietMs: 20,
});
assert(afterRelease.status === 'idle', '进程退出释放占用后可再次运行');

console.log('12. 缓冲区截断后 job_output 仍能读到新增内容且 cursor 不回退');
// 复现之前 Critical 修复的核心场景：pty-host 只保留尾部 32000 字符，
// 任务起点被挤出缓冲区后，从旧 cursor 读取必须标记 truncated、拿到当前缓冲里的
// 新内容，并且 cursor 单调不减。这里用一个小 cap 让截断容易触发。
bufferCap = 64;
// 立刻按新 cap 截断之前的旧输出，让本用例的起点从当前缓冲区末尾开始，
// 否则第一次追加时才截断，bufferStart 仍会落在任务起点之前。
appendOutput('');
const beforeTrunc = jobs.call('terminal_run', { command: 'trunc-start', pane: '#3', quietMs: 20 });
await sleep(5);
emitData('BEGIN-MARK\r\n');
const truncStart = await beforeTrunc;
const startCursor = truncStart.cursor;
assert(startCursor > 0, '截断用例拿到非零的绝对 cursor');
// 推入远超 cap 的内容，把 BEGIN-MARK 挤出缓冲区
emitData(`${'x'.repeat(bufferCap + 40)}\r\nTAIL-MARK\r\n`);
assert(
  bufferStart > startCursor,
  `缓冲区起点已越过任务起点（起点 ${bufferStart} > cursor ${startCursor}）`,
);
const afterTrunc = jobs.call('job_output', { jobId: truncStart.jobId, cursor: startCursor });
assert(afterTrunc.truncated === true, '从已被丢弃的偏移读取时标记 truncated');
assert(afterTrunc.output.includes('TAIL-MARK'), '仍能读到截断后缓冲区里的新增内容');
assert(afterTrunc.cursor >= startCursor, 'cursor 不回退');
assert(
  afterTrunc.cursor === bufferEnd(),
  `cursor 追到当前绝对末尾（${afterTrunc.cursor} / ${bufferEnd()}）`,
);
const truncCursor = afterTrunc.cursor;
emitData('AFTER-TRUNC\r\n');
const afterIncrement = jobs.call('job_output', { jobId: truncStart.jobId, cursor: truncCursor });
assert(afterIncrement.output.includes('AFTER-TRUNC'), '截断后按 cursor 继续读到新增内容');
assert(afterIncrement.truncated === false, '从当前 cursor 起再读不算截断');
assert(
  afterIncrement.cursor === bufferEnd() && afterIncrement.cursor > truncCursor,
  '后续读取的 cursor 继续前进',
);
bufferCap = Infinity;

console.log('13. terminal_wait 的匹配窗口与 pty-host 缓冲一致');
const waitTool = jobs.TOOLS.find((tool) => tool.name === 'terminal_wait');
assert(
  typeof waitTool?.description === 'string' && waitTool.description.includes('32000'),
  '工具描述写明 32000 字符',
);
assert(
  typeof waitTool?.description === 'string' && !waitTool.description.includes('64K'),
  '工具描述不再出现过期的 64K',
);

console.log(`\n全部通过：${passed} 项`);
