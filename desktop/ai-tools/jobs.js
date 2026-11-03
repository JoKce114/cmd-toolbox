const crypto = require('crypto');
const { cleanOutput } = require('./ansi');
const aiBridge = require('../ai-bridge');

const DEFAULT_QUIET_MS = 1200;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 600000;
// 新建页签后要等渲染进程把 panes:sync 送到主进程，findPane 才能定位。
// 轮询到命中即返回，比固定 sleep 更快也更稳。
const PANE_SYNC_TIMEOUT_MS = 3000;
const PANE_SYNC_POLL_MS = 50;
// 已结束的任务留一段时间给 job_output 轮询，之后清掉，避免常驻内存无限增长
const JOB_RETENTION_MS = 30 * 60 * 1000;

let writeSession = () => {};
let getLastOutput = () => '';
let isOpen = () => false;
let findPane = () => null;
let listPanes = () => [];
let subscribeData = () => () => {};
let subscribeExit = () => () => {};

const jobs = new Map();
const activeBySession = new Map();
// panes:sync 的载荷里暂时没有 aiOwned，terminal_run 自己建出来的终端先在本地
// 记下 sessionId，下一次不传 pane 时才能复用它。
const ownedSessions = new Set();

function configure(options = {}) {
  if (typeof options.writeSession === 'function') writeSession = options.writeSession;
  if (typeof options.getLastOutput === 'function') getLastOutput = options.getLastOutput;
  if (typeof options.isOpen === 'function') isOpen = options.isOpen;
  if (typeof options.findPane === 'function') findPane = options.findPane;
  if (typeof options.panes === 'function') listPanes = options.panes;
  if (typeof options.subscribeData === 'function') subscribeData = options.subscribeData;
  if (typeof options.subscribeExit === 'function') subscribeExit = options.subscribeExit;
}

// MCP 回包只取 message，错误码必须写进前缀，AI 才能稳定解析（与 panes.js 一致）。
function fail(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}

// aiBridge 的失败 Error 带 code，但 MCP 只透传 message，这里补上前缀。
async function createTerminal() {
  try {
    return await aiBridge.request('create-terminal', { groupKey: '' });
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : '';
    if (!code) throw error;
    throw fail(code, (error && error.message) || '操作失败');
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_TIMEOUT_MS;
  if (number > MAX_TIMEOUT_MS) throw fail('bad-request', 'timeoutMs 不能超过 10 分钟');
  return Math.floor(number);
}

function resolvePane(ref) {
  if (!ref) return null;
  const pane = findPane(ref);
  if (!pane) {
    throw fail('pane-not-found', '找不到这个终端窗格，请先用 list_panes 查看');
  }
  if (pane.kind !== 'terminal') {
    throw fail('pane-not-found', '这不是一个终端窗格，请先用 list_panes 查看');
  }
  return pane;
}

function isAiOwned(pane) {
  return Boolean(pane.aiOwned) || ownedSessions.has(pane.sessionId);
}

// 复用「AI 创建、未退出、无正在跑的任务」的终端页签。
function findIdleAiPane() {
  return (
    listPanes().find(
      (item) =>
        item &&
        item.kind === 'terminal' &&
        isAiOwned(item) &&
        item.sessionId &&
        !item.exited &&
        isOpen(item.sessionId) &&
        !activeBySession.has(item.sessionId),
    ) || null
  );
}

// 建页签的返回值里有 tabId 与 #N。tabId 不会跨项目重号，优先用它。
async function waitForPane(created) {
  const refs = [created && created.tabId, created && created.pane].filter(
    (ref) => typeof ref === 'string' && ref,
  );
  const deadline = Date.now() + PANE_SYNC_TIMEOUT_MS;
  for (;;) {
    for (const ref of refs) {
      let pane = null;
      try {
        pane = findPane(ref);
      } catch {
        pane = null;
      }
      if (pane) return pane;
    }
    if (Date.now() >= deadline) return null;
    await delay(PANE_SYNC_POLL_MS);
  }
}

function pruneJobs() {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [key, entry] of jobs) {
    if (entry.settled && entry.finishedAt && entry.finishedAt < cutoff) jobs.delete(key);
  }
  for (const sessionId of ownedSessions) {
    if (!isOpen(sessionId)) ownedSessions.delete(sessionId);
  }
}

function finish(job, status, exitCode, exitOutput) {
  const entry = jobs.get(job.id);
  if (!entry || entry.settled) return;
  entry.settled = true;
  entry.finishedAt = Date.now();
  activeBySession.delete(entry.sessionId);
  // 进程退出后 pty-host 会立刻删掉会话，getLastOutput 读不到了；
  // 退出事件把最后一帧输出一起带过来，这里优先用它。
  const hasExitOutput = typeof exitOutput === 'string';
  const raw = hasExitOutput ? exitOutput : getLastOutput(entry.sessionId) || '';
  // 只有退出才缓存快照。idle / running 的会话还活着，job_output 要继续读实时缓冲。
  if (hasExitOutput) entry.finalRaw = raw;
  entry.result = {
    status,
    exitCode: typeof exitCode === 'number' ? exitCode : null,
    output: cleanOutput(raw.slice(entry.baseOffset)),
    pane: `#${entry.paneNo}`,
    jobId: entry.id,
    cursor: raw.length,
  };
  if (typeof entry.cleanup === 'function') entry.cleanup();
  entry.resolve(entry.result);
}

async function terminalRun(args = {}) {
  const quietMs = Number(args.quietMs) > 0 ? Math.floor(Number(args.quietMs)) : DEFAULT_QUIET_MS;
  const timeoutMs = clampTimeout(args.timeoutMs);
  const command = String(args.command || '').trim();
  if (!command) throw fail('bad-request', 'command 不能为空');

  pruneJobs();

  let pane = resolvePane(args.pane);
  if (!pane) {
    const reuse = findIdleAiPane();
    if (reuse) {
      pane = reuse;
    } else {
      const created = await createTerminal();
      const located = await waitForPane(created);
      if (!located) throw fail('ui-unavailable', '终端创建后无法定位');
      pane = located;
      if (created && created.sessionId) {
        ownedSessions.add(created.sessionId);
        if (!pane.sessionId) pane = { ...pane, sessionId: created.sessionId };
      }
    }
  }

  const sessionId = pane.sessionId;
  if (!sessionId || !isOpen(sessionId)) {
    throw fail('pane-not-found', '该终端已退出，请重新 open_terminal');
  }
  const runningJobId = activeBySession.get(sessionId);
  if (runningJobId) {
    const error = fail('pane-busy', `该终端还有任务在跑（jobId ${runningJobId}）`);
    error.jobId = runningJobId;
    throw error;
  }

  const baseOffset = (getLastOutput(sessionId) || '').length;
  const id = crypto.randomUUID();
  activeBySession.set(sessionId, id);

  return new Promise((resolve, reject) => {
    const entry = {
      id,
      sessionId,
      paneNo: pane.paneNo,
      baseOffset,
      settled: false,
      finishedAt: 0,
      finalRaw: null,
      cleanup: null,
      resolve,
      result: null,
    };
    jobs.set(id, entry);

    let quietTimer = null;
    let timeoutTimer = null;
    const offData = subscribeData((dataSessionId) => {
      if (dataSessionId !== sessionId) return;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(entry, 'idle'), quietMs);
    });
    const offExit = subscribeExit((exitSessionId, code, exitOutput) => {
      if (exitSessionId !== sessionId) return;
      finish(entry, 'done', typeof code === 'number' ? code : 0, exitOutput);
    });

    entry.cleanup = () => {
      if (quietTimer) clearTimeout(quietTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      quietTimer = null;
      timeoutTimer = null;
      offData();
      offExit();
    };

    timeoutTimer = setTimeout(() => finish(entry, 'running'), timeoutMs);
    quietTimer = setTimeout(() => finish(entry, 'idle'), quietMs);

    try {
      writeSession(sessionId, `${command}\r`);
    } catch (error) {
      entry.settled = true;
      activeBySession.delete(sessionId);
      entry.cleanup();
      jobs.delete(id);
      reject(fail('ui-unavailable', error.message || String(error)));
    }
  });
}

function jobOutput(args = {}) {
  const entry = jobs.get(String(args.jobId || ''));
  if (!entry) throw fail('pane-not-found', '找不到这个 jobId，请重新执行命令');
  const cursor = Math.max(0, Math.floor(Number(args.cursor) || 0));
  const raw =
    typeof entry.finalRaw === 'string' ? entry.finalRaw : getLastOutput(entry.sessionId) || '';
  const start = Math.min(cursor, raw.length);
  return {
    status: entry.settled && entry.result ? entry.result.status : 'running',
    output: cleanOutput(raw.slice(start)),
    cursor: raw.length,
    jobId: entry.id,
    pane: `#${entry.paneNo}`,
  };
}

const TOOLS = [
  {
    name: 'terminal_run',
    description:
      '在终端里执行一条命令并等待结果。等到进程退出、或输出连续 quietMs 无变化、或超时后返回。返回 status（done/idle/running）、exitCode、output、pane、jobId、cursor。不传 pane 时自动复用 AI 终端页签。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        pane: { type: 'string', description: '目标终端，如 #3；省略则复用 AI 终端' },
        quietMs: { type: 'number', description: '输出安静多久算结束，默认 1200' },
        timeoutMs: { type: 'number', description: '总超时，默认 60000，上限 600000' },
      },
      required: ['command'],
    },
  },
  {
    name: 'job_output',
    description: '读取某个任务自 cursor 以来的新增输出。长任务轮询用，避免重复拿全量。',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        cursor: { type: 'number', description: '上次返回的 cursor，省略为 0' },
      },
      required: ['jobId'],
    },
  },
];

// job_output 是纯读，保持同步返回（离线用例按同步取值）；terminal_run 返回 Promise。
function call(name, args) {
  if (name === 'terminal_run') return terminalRun(args || {});
  if (name === 'job_output') return jobOutput(args || {});
  throw new Error(`未知工具：${name}`);
}

module.exports = { configure, TOOLS, call };
