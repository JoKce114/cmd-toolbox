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
const written = [];
const dataHandlers = new Set();
const exitHandlers = new Set();
const openSessions = new Set([SESSION_ID]);
const extraPanes = new Map();

function emitData(text) {
  buffer += text;
  // 处理器可能在回调里退订，先快照
  for (const handler of [...dataHandlers]) handler(SESSION_ID, text);
}

function emitExit(code, exitOutput) {
  const snapshot =
    exitOutput || { text: buffer, startOffset: 0, endOffset: buffer.length, truncated: false };
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
    const total = buffer.length;
    const requested = Number(fromOffset);
    const from = Math.min(Math.max(0, Number.isFinite(requested) ? Math.floor(requested) : 0), total);
    return {
      text: buffer.slice(from),
      startOffset: from,
      endOffset: total,
      truncated: false,
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

console.log('2. 进程退出返回 done 与真实退出码');
const beforeExit = buffer.length;
const run2 = jobs.call('terminal_run', { command: 'ls', pane: '#3', quietMs: 5000 });
await sleep(5);
emitData('file-a.txt\r\nfile-b.txt\r\n');
emitExit(3);
const result2 = await run2;
assert(result2.status === 'done', '退出返回 done');
assert(result2.exitCode === 3, '退出码原样带回（不是缺省的 0）');
assert(result2.output.includes('file-a.txt'), 'done 回包包含退出前的输出');
assert(result2.cursor > beforeExit, 'done 回包的 cursor 前进了');

console.log('3. 同一 session 并发被拒绝（pane-busy）');
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

console.log('4. 空命令被拒绝');
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

console.log('5. timeoutMs 超过 10 分钟被拒绝');
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

console.log('6. job_output 增量 cursor 不重复');
const beforeIncrement = buffer.length;
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

console.log('7. terminal_wait 先匹配已有输出');
const waitMatched = await jobs.call('terminal_wait', {
  pane: '#3',
  pattern: 'inc-one',
  timeoutMs: 200,
});
assert(waitMatched.status === 'matched', '已有输出命中时立即返回 matched');
assert(waitMatched.match === 'inc-one', '带回命中的片段');
assert(waitMatched.pane === '#3', '带回窗格编号');

console.log('8. terminal_send 的 submit 语义');
written.length = 0;
const sentDefault = jobs.call('terminal_send', { pane: '#3', text: 'quit' });
assert(sentDefault.ok === true, 'terminal_send 返回 ok');
assert(lastWrite().data === 'quit\r', 'submit 默认补回车');
jobs.call('terminal_send', { pane: '#3', text: 'q', submit: false });
assert(lastWrite().data === 'q', 'submit:false 原样发送不补回车');

console.log('9. 路径与参数错误码');
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

console.log('10. 总超时返回 running 且占用不释放');
const timedJob = jobs.call('terminal_run', {
  command: 'slow-task',
  pane: '#3',
  timeoutMs: 40,
  quietMs: 60000,
});
const timedResult = await timedJob;
assert(timedResult.status === 'running', '总超时返回 running');
await expectCode(
  () => jobs.call('terminal_run', { command: 'next', pane: '#3' }),
  'pane-busy',
  '超时回包后占用仍保留，下一条命令被拒绝',
);
emitExit(0);
await sleep(5);
const afterRelease = await jobs.call('terminal_run', {
  command: 'after',
  pane: '#3',
  quietMs: 20,
});
assert(afterRelease.status === 'idle', '进程退出释放占用后可再次运行');

console.log(`\n全部通过：${passed} 项`);
