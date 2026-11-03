const crypto = require('crypto');
const { cleanOutput } = require('./ansi');
const aiBridge = require('../ai-bridge');

const DEFAULT_QUIET_MS = 1200;
const MAX_QUIET_MS = 60000;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 600000;
// 新建页签后要等渲染进程把 panes:sync 送到主进程，findPane 才能定位。
// 轮询到命中即返回，比固定 sleep 更快也更稳。
const PANE_SYNC_TIMEOUT_MS = 3000;
const PANE_SYNC_POLL_MS = 50;
// 已结束的任务留一段时间给 job_output 轮询，之后清掉，避免常驻内存无限增长
const JOB_RETENTION_MS = 30 * 60 * 1000;

let writeSession = () => {};
let getOutputSlice = () => ({ text: '', startOffset: 0, endOffset: 0, truncated: false });
let isOpen = () => false;
let findPane = () => null;
let listPanes = () => [];
let subscribeData = () => () => {};
let subscribeExit = () => () => {};

const jobs = new Map();
// sessionId -> 占用它的 jobId。超时返回后仍保留，直到进程退出或安静下来，
// 否则下一条命令会写进同一个 pty，两条命令的输出会交错。
const activeBySession = new Map();
// 最近一次建终端 / 复用的项目，作为 terminal_run 不传 project 时的缺省目标
let lastGroupKey = '';

function configure(options = {}) {
  if (typeof options.writeSession === 'function') writeSession = options.writeSession;
  if (typeof options.getOutputSlice === 'function') getOutputSlice = options.getOutputSlice;
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
async function createTerminal(groupKey) {
  try {
    return await aiBridge.request('create-terminal', { groupKey: groupKey || '' });
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

function clampQuiet(value, timeoutMs) {
  const number = Number(value);
  const base = Number.isFinite(number) && number > 0 ? Math.floor(number) : DEFAULT_QUIET_MS;
  return Math.max(1, Math.min(base, MAX_QUIET_MS, timeoutMs));
}

// findPane 在编号跨项目重号时抛 status=409，转成带错误码的回包，
// 不能让 AI 把它当成「页签不存在」。
function resolvePane(ref) {
  if (!ref) return null;
  let pane;
  try {
    pane = findPane(ref);
  } catch (error) {
    if (error && error.status === 409) {
      throw fail('bad-request', error.message);
    }
    throw error;
  }
  if (!pane) {
    throw fail('pane-not-found', '找不到这个终端窗格，请先用 list_panes 查看');
  }
  if (pane.kind !== 'terminal') {
    throw fail('pane-not-found', '这不是一个终端窗格，请先用 list_panes 查看');
  }
  return pane;
}

// project 可以是 groupKey，也可以是项目名（渲染进程的 create-terminal 两者都认）。
// 复用只认 groupKey，panes 里有 groupKey 和 groupName 可以直接换算。
function resolveProjectHint(args) {
  const wanted = typeof args.project === 'string' ? args.project.trim() : '';
  const items = listPanes();
  if (wanted) {
    const lower = wanted.toLowerCase();
    const hit =
      items.find((pane) => pane.groupKey === wanted) ||
      items.find((pane) => String(pane.groupName || '').toLowerCase() === lower);
    return { groupKey: hit ? String(hit.groupKey || '') : wanted, label: wanted };
  }
  if (lastGroupKey) return { groupKey: lastGroupKey, label: lastGroupKey };
  const aiPane = items.find((pane) => pane.aiOwned === true && pane.groupKey);
  return aiPane ? { groupKey: String(aiPane.groupKey), label: String(aiPane.groupKey) } : null;
}

// 复用「AI 创建、未退出、无正在跑的任务」的终端页签，且必须是目标项目。
function findIdleAiPane(groupKey) {
  return (
    listPanes().find(
      (item) =>
        item &&
        item.kind === 'terminal' &&
        item.aiOwned === true &&
        item.sessionId &&
        !item.exited &&
        isOpen(item.sessionId) &&
        !activeBySession.has(item.sessionId) &&
        (!groupKey || item.groupKey === groupKey),
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
        // 轮询期间 panes 里可能短暂出现重号，继续等
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
    if (entry.released && entry.finishedAt && entry.finishedAt < cutoff) jobs.delete(key);
  }
}

// 把 pty-host 的切片换算成「从 fromOffset 起的新内容 + 绝对 cursor」。
// fromOffset 早于缓冲区起点时，缓冲区已丢弃那一段，truncated 置位。
function normalizeSlice(source, fromOffset) {
  const raw = source && typeof source === 'object' ? source : {};
  const text = typeof raw.text === 'string' ? raw.text : '';
  const endOffset = Number.isFinite(raw.endOffset) ? raw.endOffset : text.length;
  const startOffset = Number.isFinite(raw.startOffset)
    ? raw.startOffset
    : Math.max(0, endOffset - text.length);
  const from = Math.max(fromOffset, startOffset);
  return {
    text: from <= endOffset ? text.slice(from - startOffset) : '',
    // cursor 只增不减：调用方传了越界的 cursor 时也不能让它回退
    cursor: Math.max(endOffset, fromOffset),
    truncated: fromOffset < startOffset,
  };
}

function takeSlice(entry, fromOffset) {
  if (entry.finalOutput) return normalizeSlice(entry.finalOutput, fromOffset);
  return normalizeSlice(getOutputSlice(entry.sessionId, fromOffset), fromOffset);
}

function currentOffset(sessionId) {
  const slice = getOutputSlice(sessionId, Number.MAX_SAFE_INTEGER);
  if (slice && Number.isFinite(slice.endOffset)) return slice.endOffset;
  return 0;
}

function release(entry) {
  if (entry.released) return;
  entry.released = true;
  entry.finishedAt = Date.now();
  if (activeBySession.get(entry.sessionId) === entry.id) {
    activeBySession.delete(entry.sessionId);
  }
  if (typeof entry.cleanup === 'function') entry.cleanup();
}

function settlePromise(entry, result) {
  if (entry.resolved) return;
  entry.resolved = true;
  entry.resolve(result);
}

function finish(entry, status, options = {}) {
  if (entry.released) return;
  if (options.exitOutput) {
    entry.finalOutput = {
      text: String(options.exitOutput.text || ''),
      endOffset: Number(options.exitOutput.endOffset) || 0,
    };
  }
  const slice = takeSlice(entry, entry.baseOffset);
  entry.status = status;
  entry.exitCode = typeof options.exitCode === 'number' ? options.exitCode : entry.exitCode;
  entry.result = {
    status,
    exitCode: status === 'done' ? entry.exitCode : null,
    output: cleanOutput(slice.text),
    pane: `#${entry.paneNo}`,
    jobId: entry.id,
    cursor: slice.cursor,
    truncated: slice.truncated,
  };
  if (status === 'running') {
    // 总超时先回包，但命令可能还在跑：保留占用与订阅，
    // 等退出或安静后再释放，避免下一条命令和它抢同一个 pty。
    settlePromise(entry, entry.result);
    return;
  }
  release(entry);
  settlePromise(entry, entry.result);
}

async function terminalRun(args = {}) {
  const timeoutMs = clampTimeout(args.timeoutMs);
  const quietMs = clampQuiet(args.quietMs, timeoutMs);
  const command = String(args.command || '').trim();
  if (!command) throw fail('bad-request', 'command 不能为空');

  pruneJobs();

  let pane = resolvePane(args.pane);
  if (!pane) {
    const hint = resolveProjectHint(args);
    const reuse = findIdleAiPane(hint ? hint.groupKey : '');
    if (reuse) {
      pane = reuse;
      lastGroupKey = String(reuse.groupKey || hint?.groupKey || '');
    } else {
      const created = await createTerminal(hint ? hint.groupKey : '');
      const located = await waitForPane(created);
      if (!located) throw fail('ui-unavailable', '终端创建后无法定位');
      pane = located;
      const key = String((created && created.groupKey) || located.groupKey || hint?.groupKey || '');
      if (key) lastGroupKey = key;
    }
  } else if (pane.groupKey) {
    lastGroupKey = String(pane.groupKey);
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

  const baseOffset = currentOffset(sessionId);
  const id = crypto.randomUUID();
  activeBySession.set(sessionId, id);

  return new Promise((resolve, reject) => {
    const entry = {
      id,
      sessionId,
      paneNo: pane.paneNo,
      baseOffset,
      status: 'running',
      exitCode: null,
      resolved: false,
      released: false,
      finishedAt: 0,
      finalOutput: null,
      cleanup: null,
      resolve,
      result: null,
    };
    jobs.set(id, entry);

    let quietTimer = null;
    let timeoutTimer = null;
    const armQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(entry, 'idle'), quietMs);
    };
    const offData = subscribeData((dataSessionId) => {
      if (dataSessionId !== sessionId) return;
      armQuiet();
    });
    const offExit = subscribeExit((exitSessionId, code, exitOutput) => {
      if (exitSessionId !== sessionId) return;
      finish(entry, 'done', {
        exitCode: typeof code === 'number' ? code : 0,
        exitOutput,
      });
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
    armQuiet();

    try {
      writeSession(sessionId, `${command}\r`);
    } catch (error) {
      entry.released = true;
      if (activeBySession.get(sessionId) === id) activeBySession.delete(sessionId);
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
  // 会话退出后 pty-host 的缓冲已经没了，改用退出时带出来的快照
  const slice = takeSlice(entry, cursor);
  return {
    status: entry.status || 'running',
    output: cleanOutput(slice.text),
    cursor: slice.cursor,
    jobId: entry.id,
    pane: `#${entry.paneNo}`,
    truncated: slice.truncated,
  };
}

// 向已有终端写按键。与 terminal_run 共用 activeBySession 占用表：
// 同一会话上还有任务在跑时拒绝，否则两条命令的输出会交错，job 的 cursor 也会被污染。
function terminalSend(args = {}) {
  const pane = resolvePane(args.pane);
  if (!pane) throw fail('pane-not-found', '请用 list_panes 查看终端编号');
  const sessionId = pane.sessionId;
  if (!sessionId || !isOpen(sessionId)) {
    throw fail('pane-not-found', '该终端已退出');
  }
  const runningJobId = activeBySession.get(sessionId);
  if (runningJobId) {
    const error = fail('pane-busy', `该终端还有任务在跑（jobId ${runningJobId}）`);
    error.jobId = runningJobId;
    throw error;
  }
  const text = String(args.text ?? '');
  // submit 默认 true：补回车。交互式 CLI 逐键输入时传 false，原样发送。
  const submit = args.submit !== false;
  try {
    writeSession(sessionId, submit ? `${text}\r` : text);
  } catch (error) {
    throw fail('ui-unavailable', (error && error.message) || String(error));
  }
  return { ok: true, pane: `#${pane.paneNo}`, submitted: submit };
}

// 等某段输出出现。先查一次当前缓冲再订阅新数据——等服务就绪时，
// 关键字往往在调用 terminal_wait 之前就已经打出来了。
function terminalWait(args = {}) {
  const pane = resolvePane(args.pane);
  if (!pane) throw fail('pane-not-found', '请用 list_panes 查看终端编号');
  const pattern = String(args.pattern || '');
  if (!pattern) throw fail('bad-request', 'pattern 不能为空');
  let regex;
  try {
    regex = new RegExp(pattern);
  } catch {
    // MCP 只透传 message，原生 SyntaxError 对 AI 没有诊断价值
    throw fail('bad-request', 'pattern 不是合法的正则');
  }
  const timeoutMs = clampTimeout(args.timeoutMs || 30000);
  const sessionId = pane.sessionId;
  if (!sessionId || !isOpen(sessionId)) {
    throw fail('pane-not-found', '该终端已退出');
  }
  const paneLabel = `#${pane.paneNo}`;

  // 每次都读全量缓冲：pattern 可能跨 chunk，只拼增量容易漏掉边界。
  const readText = () => cleanOutput(normalizeSlice(getOutputSlice(sessionId, 0), 0).text);

  return new Promise((resolve) => {
    let timer = null;
    let offData = null;
    let settled = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (offData) {
        const off = offData;
        offData = null;
        off();
      }
    };
    const succeed = (match) => {
      if (settled) return;
      settled = true;
      const output = readText();
      cleanup();
      resolve({ status: 'matched', match, output, pane: paneLabel });
    };
    const finish = (status) => {
      if (settled) return;
      settled = true;
      const output = readText();
      cleanup();
      resolve({ status, output, pane: paneLabel });
    };

    const existing = regex.exec(readText());
    if (existing) {
      succeed(existing[0]);
      return;
    }

    const off = subscribeData((dataSessionId) => {
      if (dataSessionId !== sessionId) return;
      const found = regex.exec(readText());
      if (found) succeed(found[0]);
    });
    // subscribeData 若同步回调并命中，settled 已置位，这里补一次退订
    if (settled) {
      off();
      return;
    }
    offData = off;
    timer = setTimeout(() => finish('timeout'), timeoutMs);
  });
}

const TOOLS = [
  {
    name: 'terminal_run',
    description:
      '在终端里执行一条命令并等待结果。等到进程退出、或输出连续 quietMs 无变化、或超时后返回。返回 status（done/idle/running）、exitCode、output、pane、jobId、cursor。不传 pane 时自动复用同项目的 AI 终端页签。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        pane: { type: 'string', description: '目标终端，如 #3；省略则复用当前项目的 AI 终端' },
        project: {
          type: 'string',
          description: '项目名或 groupKey，省略则用最近一次建终端的项目',
        },
        quietMs: { type: 'number', description: '输出安静多久算结束，默认 1200，上限 60000' },
        timeoutMs: { type: 'number', description: '总超时，默认 60000，上限 600000' },
      },
      required: ['command'],
    },
  },
  {
    name: 'job_output',
    description:
      '读取某个任务自 cursor 以来的新增输出。长任务轮询用，避免重复拿全量。cursor 是绝对字符偏移，原样回传即可。',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        cursor: { type: 'number', description: '上次返回的 cursor，省略为 0' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'terminal_send',
    description:
      '向已有终端发送按键。submit 默认 true（补回车）；交互式 CLI 逐键输入时传 false。该终端有任务在跑时返回 pane-busy。',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string', description: '目标终端，如 #3' },
        text: { type: 'string', description: '要发送的按键，空串表示只发回车' },
        submit: { type: 'boolean', description: '是否补回车，默认 true' },
      },
      required: ['pane', 'text'],
    },
  },
  {
    name: 'terminal_wait',
    description:
      '等待终端输出匹配某个正则。先匹配已有输出，再等新输出。用于等服务启动就绪、等交互式 CLI 打出提示。返回 status（matched/timeout）与匹配片段。',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string', description: '目标终端，如 #3' },
        pattern: { type: 'string', description: '正则字符串' },
        timeoutMs: { type: 'number', description: '默认 30000，上限 600000' },
      },
      required: ['pane', 'pattern'],
    },
  },
];

// job_output 是纯读，保持同步返回（离线用例按同步取值）；terminal_run / terminal_wait 返回 Promise。
function call(name, args) {
  if (name === 'terminal_run') return terminalRun(args || {});
  if (name === 'job_output') return jobOutput(args || {});
  if (name === 'terminal_send') return terminalSend(args || {});
  if (name === 'terminal_wait') return terminalWait(args || {});
  throw new Error(`未知工具：${name}`);
}

module.exports = { configure, TOOLS, call };
