const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { resolveWithin } = require('./path-guard');

const FAST_TIMEOUT = 15000;
const PUSH_TIMEOUT = 120000;
const NETWORK_TIMEOUT = 60000;
const FETCH_TIMEOUT = 15000;
const MAX_BUFFER = 8 * 1024 * 1024;

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// 未跟踪目录在 porcelain 里显示为 `? dir/`，fs.rm 不加 recursive 时不会删除目录
async function removePath(projectPath, item) {
  const target = resolveWithin(projectPath, item);
  let recursive = false;
  try {
    recursive = (await fsp.stat(target)).isDirectory();
  } catch {
    // 路径已不存在时由 rm 的 force 静默处理
  }
  await fsp.rm(target, { force: true, recursive });
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

// XY 两位：X 是暂存区状态，Y 是工作区状态，'.' 表示该侧无变化
function statusFromChar(char) {
  if (!char || char === '.' || char === ' ') return null;
  return TYPE_BY_CHAR[char] || 'modified';
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
      changes.push({ path: entry.slice(2), indexStatus: null, worktreeStatus: 'untracked' });
      continue;
    }
    if (entry.startsWith('! ')) continue;
    if (entry.startsWith('u ')) {
      const fields = entry.split(' ');
      changes.push({
        path: fields.slice(10).join(' '),
        indexStatus: 'conflicted',
        worktreeStatus: 'conflicted',
      });
      continue;
    }
    if (entry.startsWith('1 ')) {
      const fields = entry.split(' ');
      const xy = fields[1] || '..';
      changes.push({
        path: fields.slice(8).join(' '),
        indexStatus: statusFromChar(xy[0]),
        worktreeStatus: statusFromChar(xy[1]),
      });
      continue;
    }
    if (entry.startsWith('2 ')) {
      const fields = entry.split(' ');
      const xy = fields[1] || '..';
      const origPath = parts[index + 1] || '';
      index += 1;
      changes.push({
        path: fields.slice(9).join(' '),
        origPath,
        indexStatus: statusFromChar(xy[0]),
        worktreeStatus: statusFromChar(xy[1]),
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
    stagedCount: changes.filter((change) => change.indexStatus !== null).length,
    unstagedCount: changes.filter((change) => change.worktreeStatus !== null).length,
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

  const result = await runGit(projectPath, ['commit', '-m', text]);
  if (!result.ok) {
    if (/nothing to commit|no changes added/i.test(`${result.stdout}${result.stderr}`)) {
      throw new Error('没有已暂存的内容可提交');
    }
    throw new Error(cleanError(result.error, result.stderr));
  }

  const head = await runGit(projectPath, ['rev-parse', '--short', 'HEAD']);
  return { commit: head.stdout.trim(), summary: text.split('\n')[0] };
}

async function stage(projectPath, paths) {
  const list = (Array.isArray(paths) ? paths : []).filter(Boolean);
  if (!list.length) return { ok: true };
  list.forEach((item) => resolveWithin(projectPath, item));
  const result = await runGit(projectPath, ['add', '--', ...list]);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { ok: true };
}

async function unstage(projectPath, paths) {
  const list = (Array.isArray(paths) ? paths : []).filter(Boolean);
  if (!list.length) return { ok: true };
  list.forEach((item) => resolveWithin(projectPath, item));
  const head = await runGit(projectPath, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const args = head.ok
    ? ['restore', '--staged', '--', ...list]
    : ['rm', '--cached', '--force', '--', ...list];
  const result = await runGit(projectPath, args);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { ok: true };
}

async function discard(projectPath, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const tracked = (Array.isArray(input.tracked) ? input.tracked : []).filter(Boolean);
  const untracked = (Array.isArray(input.untracked) ? input.untracked : []).filter(Boolean);

  if (tracked.length) {
    tracked.forEach((item) => resolveWithin(projectPath, item));
    const result = await runGit(projectPath, ['restore', '--', ...tracked]);
    if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  }

  for (const item of untracked) {
    await removePath(projectPath, item);
  }

  return { ok: true };
}

async function stageAll(projectPath) {
  const result = await runGit(projectPath, ['add', '-A']);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { ok: true };
}

async function discardAll(projectPath) {
  // 空仓库（尚无 HEAD）没有可 restore 的对象，跳过前两步
  const head = await runGit(projectPath, ['rev-parse', '--verify', '--quiet', 'HEAD']);

  if (head.ok) {
    // 先清空暂存区再丢弃工作区改动，否则已暂存的新增文件会残留
    const unstageResult = await runGit(projectPath, ['restore', '--staged', '.']);
    if (!unstageResult.ok) {
      throw new Error(cleanError(unstageResult.error, unstageResult.stderr));
    }

    const restoreResult = await runGit(projectPath, ['restore', '.']);
    if (!restoreResult.ok) {
      throw new Error(cleanError(restoreResult.error, restoreResult.stderr));
    }
  }

  // 未跟踪文件没有被 restore 覆盖，需要逐个删除；空仓库里它们就是全部内容
  const current = await status(projectPath);
  if (current.ok) {
    for (const change of current.changes) {
      if (change.worktreeStatus !== 'untracked') continue;
      await removePath(projectPath, change.path);
    }
  }

  return { ok: true };
}

const BRANCH_NAME = /^(?!.*\.\.)(?!.*\s)[^\x00-\x20~^:?*\[\\]+$/;

function assertBranchName(name) {
  const value = String(name || '').trim();
  if (!value) throw new Error('请填写分支名');
  if (value.length > 100) throw new Error('分支名过长');
  if (!BRANCH_NAME.test(value)) throw new Error('分支名包含不允许的字符');
  if (value.startsWith('-')) throw new Error('分支名不能以 - 开头');
  if (value.startsWith('/') || value.endsWith('/') || value.endsWith('.lock')) {
    throw new Error('分支名格式不合法');
  }
  return value;
}

async function branches(projectPath) {
  const result = await runGit(projectPath, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
  ]);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));

  const head = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  let current = head.ok ? head.stdout.trim() : '';
  if (!current) {
    // 空仓库（尚无提交）没有 HEAD，用符号引用获取当前分支名
    const sym = await runGit(projectPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (sym.ok) current = sym.stdout.trim();
  }

  const all = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const list =
    current && all.includes(current)
      ? [current, ...all.filter((item) => item !== current).sort()]
      : all.sort();

  return { current, list };
}

async function checkout(projectPath, branch) {
  const name = assertBranchName(branch);
  const result = await runGit(projectPath, ['checkout', name]);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { ok: true };
}

async function createBranch(projectPath, name, startPoint) {
  const branchName = assertBranchName(name);
  const base = startPoint ? assertBranchName(startPoint) : '';
  const args = base
    ? ['checkout', '-b', branchName, base]
    : ['checkout', '-b', branchName];
  const result = await runGit(projectPath, args);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { ok: true };
}

async function merge(projectPath, branch) {
  const name = assertBranchName(branch);
  const result = await runGit(projectPath, ['merge', name]);
  if (result.ok) return { ok: true, conflicted: [] };

  // 优先看索引里的未合并条目：不受输出语言影响，也能识别 modify/delete 冲突
  const current = await status(projectPath);
  const conflicted = current.ok
    ? current.changes
        .filter((change) => change.indexStatus === 'conflicted')
        .map((change) => change.path)
    : [];
  if (conflicted.length) return { ok: true, conflicted };

  // 状态读取失败或冲突已被自动解决时，退回解析英文输出
  const parsed = [
    ...new Set(
      `${result.stdout}\n${result.stderr}`
        .split('\n')
        .map((line) => line.match(/(?:Merge conflict in|CONFLICT \([^)]*\):) (.+)$/))
        .filter(Boolean)
        .map((match) => match[1].trim()),
    ),
  ];
  if (parsed.length) return { ok: true, conflicted: parsed };

  throw new Error(cleanError(result.error, result.stderr));
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

// 只更新远程跟踪分支，不改工作区；失败由调用方决定是否提示
async function fetchRemote(projectPath) {
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');
  const result = await runGit(projectPath, ['fetch', '--prune'], {
    timeout: FETCH_TIMEOUT,
  });
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { ok: true };
}

// 只做快进；需要合并或变基时让用户去终端，避免在面板里产生意料外的合并
async function pull(projectPath) {
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');

  const upstream = await runGit(projectPath, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);
  if (!upstream.ok || !upstream.stdout.trim()) {
    const branchResult = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = branchResult.stdout.trim() || '当前分支';
    throw new Error(`当前分支没有上游，无法拉取。请先在终端执行 git push -u origin ${branch}`);
  }

  const result = await runGit(projectPath, ['pull', '--ff-only'], {
    timeout: NETWORK_TIMEOUT,
  });
  if (!result.ok) {
    const text = `${result.stdout}\n${result.stderr}`;
    if (/not possible to fast-forward|divergent|have diverged/i.test(text)) {
      throw new Error('本地和线上分支已分叉，无法快进。请到终端执行 git pull 后处理');
    }
    throw new Error(cleanError(result.error, result.stderr));
  }
  return { ok: true };
}

async function diffCommand(projectPath, filePath, changeStatus) {
  const root = path.resolve(projectPath);
  const target = resolveWithin(root, String(filePath || ''));
  const relative = path.relative(root, target);
  if (!relative) {
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

module.exports = {
  status,
  commit,
  push,
  fetchRemote,
  pull,
  init,
  diffCommand,
  stage,
  unstage,
  discard,
  stageAll,
  discardAll,
  branches,
  checkout,
  createBranch,
  merge,
};
