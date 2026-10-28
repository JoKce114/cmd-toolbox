const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { resolveShell } = require('./shells');
const mcpConfig = require('./mcp-config');

let extraEnv = {};

let ptyModule = null;
let ptyLoadError = '';

// Load lazily so a transient failure (locked helper files, antivirus scan)
// can recover on the next terminal instead of degrading the whole session.
function getPty() {
  if (ptyModule) return ptyModule;
  const candidates = [];
  if (process.resourcesPath) {
    const unpacked = path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      'node-pty',
    );
    if (fs.existsSync(unpacked)) candidates.push(unpacked);
  }
  candidates.push('node-pty');

  const failures = [];
  for (const candidate of candidates) {
    try {
      ptyModule = require(candidate);
      ptyLoadError = '';
      return ptyModule;
    } catch (error) {
      failures.push(error.message);
    }
  }
  ptyLoadError = failures.join(' | ');
  console.warn('node-pty unavailable:', ptyLoadError);
  return null;
}

const sessions = new Map();

let injector = null;
let injectorBuffer = '';

function injectorPath() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'coninject.exe'));
  candidates.push(path.join(__dirname, '..', 'build', 'coninject.exe'));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // keep looking
    }
  }
  return '';
}

// A detached helper injects native console input records. ConPTY translates VT
// input in ways that can never express Ctrl+J or mouse wheels, so the only way
// to let console UIs (Grok, crossterm) see a real wheel is through CONIN$.
function getInjector() {
  if (injector) return injector;
  const binary = injectorPath();
  if (!binary) return null;
  try {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    child.stdout.on('data', (chunk) => {
      injectorBuffer += chunk;
      const lines = injectorBuffer.split('\n');
      injectorBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('error')) console.warn('[coninject]', line.trim());
      }
    });
    child.stdin.on('error', () => {});
    child.on('error', () => {
      if (injector === child) injector = null;
    });
    child.on('exit', () => {
      if (injector === child) injector = null;
    });
    injector = child;
    return child;
  } catch {
    return null;
  }
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function setExtraEnv(env) {
  extraEnv = env && typeof env === 'object' ? env : {};
}

function sessionEnv() {
  const env = {
    ...process.env,
    ...extraEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    PYTHONIOENCODING: 'utf-8',
  };
  // Paint Grok with the terminal's own palette so its surface matches the app
  // theme and follows live light/dark switches.
  if (!env.GROK_THEME && !env.LC_GROK_THEME) {
    env.GROK_THEME = 'terminal';
    env.GROK_TERMINAL_THEME = '1';
  }
  return env;
}

function createPipeDecoder(shell) {
  const encoding = process.platform === 'win32' && shell.id !== 'gitbash' ? 'gbk' : 'utf-8';
  try {
    return new TextDecoder(encoding);
  } catch {
    return new TextDecoder('utf-8');
  }
}

function createPipeSession(shell, cwd, onData, onExit) {
  const proc = spawn(shell.file, shell.args, {
    cwd,
    env: sessionEnv(),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const decoder = createPipeDecoder(shell);
  const forward = (buffer) => onData(decoder.decode(buffer, { stream: true }));
  proc.stdout.on('data', forward);
  proc.stderr.on('data', forward);
  proc.on('exit', (code) => onExit(code ?? 0, null));
  proc.on('error', () => onExit(1, null));

  return {
    write(data) {
      if (proc.stdin.writable) proc.stdin.write(data);
    },
    resize() {},
    kill() {
      proc.kill();
    },
  };
}

function createPtySession(shell, cwd, cols, rows) {
  const pty = getPty();
  if (!pty) return { proc: null, error: ptyLoadError };
  const options = {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: sessionEnv(),
  };

  if (process.platform === 'win32') {
    let conptyError;
    try {
      return { proc: pty.spawn(shell.file, shell.args, { ...options, useConpty: true }), error: '' };
    } catch (error) {
      conptyError = error;
    }
    try {
      return { proc: pty.spawn(shell.file, shell.args, { ...options, useConpty: false }), error: '' };
    } catch (winptyError) {
      const detail = `ConPTY: ${conptyError.message}; winpty: ${winptyError.message}`;
      console.warn('ConPTY and winpty both failed:', detail);
      return { proc: null, error: detail };
    }
  }

  try {
    return { proc: pty.spawn(shell.file, shell.args, options), error: '' };
  } catch (error) {
    console.warn('Failed to spawn pty:', error.message);
    return { proc: null, error: error.message };
  }
}

function shortReason(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function spawnSession(payload, send) {
  const cwd = payload.cwd;
  if (!isDirectory(cwd)) throw new Error('项目目录不存在，请检查路径');

  const shell = resolveShell(payload.shellId, {
    resume: Boolean(payload.resume),
    resumeId: payload.resumeId,
    sessionId: payload.sessionId,
  });
  const cols = clamp(payload.cols, 20, 500, 100);
  const rows = clamp(payload.rows, 5, 300, 30);
  const id = crypto.randomUUID();
  const groupKey = typeof payload.groupKey === 'string' ? payload.groupKey.slice(0, 120) : '';

  if (mcpConfig.isCliTool(shell.id)) {
    const url = extraEnv.CMDTOOLBOX_MCP_URL;
    const token = extraEnv.CMDTOOLBOX_MCP_TOKEN;
    if (url && token) {
      mcpConfig.installForProject(cwd, {
        mcpUrl: `${String(url).replace(/\/$/, '')}/mcp?token=${token}`,
      });
    }
  }

  let exitNotified = false;
  let lastOutput = '';
  const onData = (data) => {
    lastOutput = `${lastOutput}${data}`;
    if (lastOutput.length > 32000) lastOutput = lastOutput.slice(-32000);
    const session = sessions.get(id);
    if (session) session.lastOutput = lastOutput;
    send('pty:data', id, data);
  };
  const onExit = (code, signal) => {
    if (exitNotified) return;
    exitNotified = true;
    sessions.delete(id);
    send('pty:exit', id, code, signal);
  };

  const attempt = createPtySession(shell, cwd, cols, rows);
  let proc = attempt.proc;
  let kind = 'pty';

  if (!proc) {
    proc = createPipeSession(shell, cwd, onData, onExit);
    kind = 'pipe';
    const reason = shortReason(attempt.error);
    const suffix = reason ? `（${reason}）` : '';
    onData(
      `\x1b[33m[提示] 伪终端不可用，已降级为管道模式${suffix}。请点击右上角「重新启动」或用新终端重试。\x1b[0m\r\n`,
    );
  } else {
    proc.onData(onData);
    proc.onExit(({ exitCode, signal }) => onExit(exitCode ?? 0, signal ?? null));
  }

  sessions.set(id, {
    id,
    proc,
    pid: typeof proc.pid === 'number' ? proc.pid : 0,
    kind,
    groupKey,
    cwd,
    shellId: shell.id,
    lastOutput: '',
  });

  return { id };
}

function writeSession(id, data) {
  if (typeof data !== 'string' || !data) return;
  const session = sessions.get(id);
  if (!session) return;
  try {
    session.proc.write(data);
  } catch {
    // the process may have exited between keystrokes
  }
}

function wheelSession(id, delta, col, row) {
  if (delta !== 120 && delta !== -120) return;
  const session = sessions.get(id);
  if (!session) return;

  if (session.kind === 'pty' && session.pid) {
    const helper = getInjector();
    if (helper && helper.stdin.writable) {
      const x = clamp(col, 0, 32767, 0);
      const y = clamp(row, 0, 32767, 0);
      helper.stdin.write(`wheel ${session.pid} ${delta} ${x} ${y}\n`);
      return;
    }
  }

  // Without the helper, page keys still work in full-screen pagers.
  try {
    session.proc.write(delta > 0 ? '\x1b[5~' : '\x1b[6~');
  } catch {
    // the process may have exited between keystrokes
  }
}

function clickSession(id, col, row) {
  const session = sessions.get(id);
  if (!session || session.kind !== 'pty' || !session.pid) return;
  const helper = getInjector();
  if (!helper || !helper.stdin.writable) return;
  const x = clamp(col, 0, 32767, 0);
  const y = clamp(row, 0, 32767, 0);
  helper.stdin.write(`click ${session.pid} ${x} ${y}\n`);
}

function altVSession(id) {
  const session = sessions.get(id);
  if (!session || session.kind !== 'pty' || !session.pid) return false;
  const helper = getInjector();
  if (!helper || !helper.stdin.writable) return false;
  helper.stdin.write(`altv ${session.pid}\n`);
  return true;
}

function resizeSession(id, cols, rows) {
  const session = sessions.get(id);
  if (!session || session.kind === 'pipe') return;
  const nextCols = clamp(cols, 20, 500, 0);
  const nextRows = clamp(rows, 5, 300, 0);
  if (!nextCols || !nextRows) return;
  try {
    session.proc.resize(nextCols, nextRows);
  } catch {
    // ignore resize races while a process is starting or exiting
  }
}

function killSession(id) {
  if (typeof id !== 'string') return;
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  try {
    session.proc.kill();
  } catch {
    // already gone
  }
}

function closeByGroup(groupKey) {
  if (!groupKey) return;
  for (const session of [...sessions.values()]) {
    if (session.groupKey === groupKey) killSession(session.id);
  }
}

function interruptCliSessions() {
  for (const session of sessions.values()) {
    if (!['grok', 'codex', 'claude', 'gemini', 'opencode'].includes(session.shellId)) continue;
    try {
      session.proc.write('\x03');
    } catch {
      // already gone
    }
  }
}

function closeAll() {
  for (const id of [...sessions.keys()]) killSession(id);
}

function isOpen(id) {
  return sessions.has(id);
}

function getLastOutput(id) {
  const session = sessions.get(id);
  return session && session.lastOutput ? session.lastOutput : '';
}

module.exports = {
  setExtraEnv,
  getLastOutput,
  spawnSession,
  writeSession,
  wheelSession,
  clickSession,
  altVSession,
  resizeSession,
  killSession,
  closeByGroup,
  interruptCliSessions,
  closeAll,
  isOpen,
};
