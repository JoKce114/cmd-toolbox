const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const FAST_TIMEOUT = 15000;
const PUSH_TIMEOUT = 120000;
const MAX_BUFFER = 8 * 1024 * 1024;

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function cleanError(error, stderr) {
  const text = String(stderr || '').trim() || (error && error.message) || 'git 执行失败';
  return text.split('\n').filter(Boolean).slice(-3).join('\n').slice(0, 300);
}

function runGit(cwd, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        windowsHide: true,
        timeout: options.timeout || FAST_TIMEOUT,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          error,
          enoent: Boolean(error && error.code === 'ENOENT'),
          stdout: stdout || '',
          stderr: stderr || '',
        });
      },
    );
  });
}

const TYPE_BY_CHAR = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'added',
  T: 'modified',
};

// XY 两位分别表示暂存区与工作区状态；工作区有变化时以工作区为准。
function mapStatus(xy) {
  const worktree = xy[1];
  const index = xy[0];
  const picked = worktree !== '.' && worktree !== '?' ? worktree : index;
  return TYPE_BY_CHAR[picked] || 'modified';
}

function parseStatus(raw) {
  const parts = raw.split('\0');
  const changes = [];
  let branch = '';
  let upstream = '';
  let ahead = 0;
  let behind = 0;

  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry) continue;

    if (entry.startsWith('# branch.head ')) {
      branch = entry.slice('# branch.head '.length).trim();
      if (branch === '(detached)') branch = '游离 HEAD';
      continue;
    }
    if (entry.startsWith('# branch.upstream ')) {
      upstream = entry.slice('# branch.upstream '.length).trim();
      continue;
    }
    if (entry.startsWith('# branch.ab ')) {
      const match = entry.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (entry.startsWith('# ')) continue;

    if (entry.startsWith('? ')) {
      changes.push({ path: entry.slice(2), status: 'untracked' });
      continue;
    }
    if (entry.startsWith('! ')) continue;
    if (entry.startsWith('u ')) {
      const fields = entry.split(' ');
      changes.push({ path: fields.slice(10).join(' '), status: 'conflicted' });
      continue;
    }
    if (entry.startsWith('1 ')) {
      const fields = entry.split(' ');
      changes.push({
        path: fields.slice(8).join(' '),
        status: mapStatus(fields[1] || '..'),
      });
      continue;
    }
    if (entry.startsWith('2 ')) {
      const fields = entry.split(' ');
      const origPath = parts[index + 1] || '';
      index += 1;
      changes.push({
        path: fields.slice(9).join(' '),
        origPath,
        status: 'renamed',
      });
      continue;
    }
  }

  return {
    ok: true,
    branch,
    upstream,
    ahead,
    behind,
    changes,
    hasChanges: changes.length > 0,
  };
}

async function status(projectPath) {
  if (!isDirectory(projectPath)) {
    return { ok: false, reason: 'missing-dir', message: '项目目录不存在' };
  }
  const result = await runGit(projectPath, [
    '-c',
    'core.quotepath=false',
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
  ]);
  if (result.enoent) {
    return {
      ok: false,
      reason: 'no-git',
      message: '未检测到 Git，请先安装 Git for Windows',
    };
  }
  if (!result.ok) {
    if (/not a git repository/i.test(result.stderr)) {
      return { ok: false, reason: 'not-repo', message: '当前项目不是 Git 仓库' };
    }
    return { ok: false, reason: 'error', message: cleanError(result.error, result.stderr) };
  }
  return parseStatus(result.stdout);
}

async function commit(projectPath, message) {
  const text = String(message || '').trim();
  if (!text) throw new Error('请填写提交信息');
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');

  const add = await runGit(projectPath, ['add', '-A']);
  if (!add.ok) throw new Error(cleanError(add.error, add.stderr));

  const result = await runGit(projectPath, ['commit', '-m', text]);
  if (!result.ok) {
    if (/nothing to commit|no changes added/i.test(`${result.stdout}${result.stderr}`)) {
      throw new Error('没有可提交的变更');
    }
    throw new Error(cleanError(result.error, result.stderr));
  }

  const head = await runGit(projectPath, ['rev-parse', '--short', 'HEAD']);
  return { commit: head.stdout.trim(), summary: text.split('\n')[0] };
}

async function push(projectPath) {
  const pre = await runGit(projectPath, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);
  const upstream = pre.ok ? pre.stdout.trim() : '';
  if (!upstream) {
    const branchResult = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = branchResult.stdout.trim() || '当前分支';
    throw new Error(`当前分支没有上游，请先在终端执行 git push -u origin ${branch}`);
  }

  const result = await runGit(projectPath, ['push'], { timeout: PUSH_TIMEOUT });
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { upstream };
}

async function init(projectPath) {
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');
  const result = await runGit(projectPath, ['init']);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { ok: true };
}

async function diffCommand(projectPath, filePath, changeStatus) {
  const root = path.resolve(projectPath);
  const target = path.resolve(root, String(filePath || ''));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('文件路径不在项目目录内');
  }
  // 命令最终输入 cmd，% 会被当作变量展开，双引号里的 " 也会截断参数
  if (/["%\r\n]/.test(relative)) {
    throw new Error('文件路径包含不支持的字符（" 或 %），请在终端手动查看');
  }

  const quoted = `"${relative}"`;
  if (changeStatus === 'untracked') {
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
    return { command: `git --no-pager diff --no-index -- ${nullDevice} ${quoted}` };
  }
  return { command: `git --no-pager diff -- ${quoted}` };
}

module.exports = { status, commit, push, init, diffCommand };
