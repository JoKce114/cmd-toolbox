const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI_TOOLS = [
  { id: 'grok', label: 'Grok', command: 'grok', args: [] },
  { id: 'codex', label: 'Codex', command: 'codex', args: [] },
  { id: 'claude', label: 'Claude', command: 'claude', args: ['--dangerously-skip-permissions'] },
  { id: 'gemini', label: 'Gemini', command: 'gemini', args: [] },
  { id: 'opencode', label: 'OpenCode', command: 'opencode', args: [] },
];

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function findGitBash() {
  const candidates = [
    process.env.CMDTOOLBOX_GIT_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
      : null,
  ].filter(Boolean);

  return candidates.find(isFile) || null;
}

function windowsShellPath(name) {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name);
}

function listShells() {
  if (process.platform !== 'win32') {
    const shells = [{ id: 'cmd', label: 'Terminal', available: isFile(process.env.SHELL || '/bin/bash') }];
    return shells.filter((shell) => shell.available);
  }

  const shells = [
    {
      id: 'cmd',
      label: '命令提示符',
      available: isFile(process.env.ComSpec || windowsShellPath('cmd.exe')),
    },
    {
      id: 'powershell',
      label: 'PowerShell',
      available: isFile(windowsShellPath('WindowsPowerShell\\v1.0\\powershell.exe')),
    },
  ];

  if (findGitBash()) {
    shells.push({ id: 'gitbash', label: 'Git Bash', available: true });
  }

  return shells.filter((shell) => shell.available);
}

function findOnPath(command) {
  if (process.platform !== 'win32') {
    const directories = String(process.env.PATH || '').split(path.delimiter);
    for (const directory of directories) {
      const candidate = path.join(directory, command);
      if (isFile(candidate)) return candidate;
    }
    return null;
  }

  try {
    const output = execFileSync('where.exe', [command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
    });
    const files = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && isFile(line));
    return (
      files.find((file) => /\.exe$/i.test(file)) ||
      files.find((file) => /\.cmd$/i.test(file)) ||
      files.find((file) => /\.bat$/i.test(file)) ||
      null
    );
  } catch {
    return null;
  }
}

function quoteCmdArg(value) {
  if (!/[\s"]/.test(value)) return value;
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function resolveRunnable(file, extraArgs) {
  const extension = path.extname(file).toLowerCase();
  if (extension !== '.cmd' && extension !== '.bat') {
    return { file, args: extraArgs };
  }
  const comspec = process.env.ComSpec || windowsShellPath('cmd.exe');
  const command = [quoteCmdArg(file), ...extraArgs.map(quoteCmdArg)].join(' ');
  return { file: comspec, args: ['/d', '/s', '/c', command] };
}

function listTools() {
  return CLI_TOOLS.map((tool) => {
    const available = Boolean(findOnPath(tool.command));
    return {
      id: tool.id,
      label: tool.label,
      available,
      hint: available ? '' : `未安装 ${tool.label}，装好后重启 Cmd Toolbox`,
    };
  });
}

function resumeArgs(tool, resumeId) {
  const id = typeof resumeId === 'string' ? resumeId.trim() : '';
  if (tool.id === 'grok') return id ? ['--resume', id] : ['--continue'];
  if (tool.id === 'claude') {
    return id
      ? ['--dangerously-skip-permissions', '--resume', id]
      : ['--dangerously-skip-permissions', '--continue'];
  }
  if (tool.id === 'codex') return id ? ['resume', id] : ['resume', '--last'];
  if (tool.id === 'opencode') return id ? ['--session', id] : ['--continue'];
  if (tool.id === 'gemini') return id ? ['--resume', id] : ['--continue'];
  return tool.args;
}

function launchArgs(tool, options) {
  const resume = Boolean(options && options.resume);
  if (resume) return resumeArgs(tool, '');
  return tool.args;
}

function resolveCli(id, options) {
  const tool = CLI_TOOLS.find((item) => item.id === id);
  if (!tool) return null;
  const file = findOnPath(tool.command);
  if (!file) throw new Error(`未找到 ${tool.label}，请先安装后再试`);
  const runnable = resolveRunnable(file, launchArgs(tool, options));
  return {
    id: tool.id,
    label: tool.label,
    file: runnable.file,
    args: runnable.args,
  };
}

function resolveShell(id, options) {
  const cli = resolveCli(typeof id === 'string' ? id : '', options);
  if (cli) return cli;

  if (process.platform !== 'win32') {
    const file = process.env.SHELL || '/bin/bash';
    if (!isFile(file)) throw new Error('未找到可用的 Shell');
    return { id: 'cmd', label: 'Terminal', file, args: [] };
  }

  const shellId = typeof id === 'string' && id ? id : 'cmd';
  if (shellId === 'cmd') {
    const file = process.env.ComSpec || windowsShellPath('cmd.exe');
    if (!isFile(file)) throw new Error('未找到命令提示符 (cmd.exe)');
    return { id: 'cmd', label: '命令提示符', file, args: [] };
  }

  if (shellId === 'powershell') {
    const file = windowsShellPath('WindowsPowerShell\\v1.0\\powershell.exe');
    if (!isFile(file)) throw new Error('未找到 PowerShell');
    return { id: 'powershell', label: 'PowerShell', file, args: ['-NoLogo'] };
  }

  if (shellId === 'gitbash') {
    const file = findGitBash();
    if (!file) throw new Error('未找到 Git Bash，请先安装 Git for Windows');
    return { id: 'gitbash', label: 'Git Bash', file, args: ['--login', '-i'] };
  }

  throw new Error('不支持的终端类型');
}

module.exports = { listShells, listTools, resolveShell };
