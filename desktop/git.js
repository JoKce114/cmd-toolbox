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

// OpenSSH 9 之后的每次连接都会往 stderr 打「抗量子」提示，与操作结果无关；
// 直接拼进 toast 会盖住真正的失败原因，这里按行过滤掉
const NOISE_LINES = [
  /post-quantum/i,
  /store now, decrypt later/i,
  /openssh\.com\/pq/i,
  /^hint:/i,
];

function cleanError(error, stderr) {
  if (error && error.killed) return 'Git 操作超时，请检查网络或稍后重试';

  const raw = String(stderr || '').trim() || (error && error.message) || '';
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const meaningful = lines.filter((line) => !NOISE_LINES.some((pattern) => pattern.test(line)));
  const pool = meaningful.length ? meaningful : lines;

  // git 的结论行在最后，且只有 fatal / error 行是用户需要看的
  const verdict = [...pool].reverse().find((line) => /^(fatal|error)\s*:/.test(line));
  const text = (verdict || pool.slice(-2).join(' '))
    .replace(/^(fatal|error)\s*:\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text || /^Command failed:/i.test(text)) {
    return 'git 执行失败，请确认 Git 已正确安装并重试';
  }
  return text.slice(0, 300);
}

async function currentBranch(projectPath) {
  const result = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return result.ok ? result.stdout.trim() : '';
}

async function upstreamOf(projectPath) {
  const result = await runGit(projectPath, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);
  return result.ok ? result.stdout.trim() : '';
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

async function push(projectPath, options = {}) {
  const upstream = await upstreamOf(projectPath);
  if (!upstream) {
    const branch = (await currentBranch(projectPath)) || '当前分支';
    return {
      ok: false,
      reason: 'no-upstream',
      message: `当前分支没有上游，请先在终端执行 git push -u origin ${branch}`,
    };
  }

  const args = options.force ? ['push', '--force-with-lease'] : ['push'];
  const result = await runGit(projectPath, args, { timeout: PUSH_TIMEOUT });
  if (result.ok) return { ok: true, upstream };

  const text = `${result.stdout}\n${result.stderr}`;
  // 非快进是分叉场景，交给上层弹出「拉取合并 / 拉取变基 / 强制推送」的选择
  if (/non-fast-forward|fetch first|\[rejected\]|rejected/i.test(text)) {
    return {
      ok: false,
      reason: 'rejected',
      message: '线上分支有本地没有的提交，推送被拒绝',
    };
  }
  throw new Error(cleanError(result.error, result.stderr));
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

// ff：只允许快进；merge / rebase：分叉时按 VSCode 的两种拉取方式处理
const PULL_FLAGS = {
  ff: ['--ff-only'],
  merge: ['--no-rebase', '--no-edit'],
  rebase: ['--rebase'],
};

async function pull(projectPath, options = {}) {
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');
  const strategy = PULL_FLAGS[options.strategy] ? options.strategy : 'ff';
  const branch = (await currentBranch(projectPath)) || '当前分支';

  const upstream = await upstreamOf(projectPath);
  if (!upstream) {
    return {
      ok: false,
      reason: 'no-upstream',
      message: `当前分支没有上游，无法拉取。请先在终端执行 git push -u origin ${branch}`,
    };
  }

  const result = await runGit(projectPath, ['pull', ...PULL_FLAGS[strategy]], {
    timeout: NETWORK_TIMEOUT,
  });
  if (result.ok) return { ok: true, strategy, branch, upstream };

  const text = `${result.stdout}\n${result.stderr}`;
  // .git/config 里 branch.X.merge 有重复项时 git 会拒绝任何形式的拉取
  if (/multiple branches/i.test(text)) {
    return {
      ok: false,
      reason: 'multiple-branches',
      message: `分支「${branch}」配置了多个上游合并目标（.git/config 中 branch.${branch}.merge 重复），Git 无法判断该拉取哪个分支`,
    };
  }

  const conflicted = await collectConflicts(projectPath, result);
  if (conflicted.length) {
    // 变基冲突时仓库会停在 rebase 中间态，应用里没有 continue/abort 入口，直接放弃
    if (strategy === 'rebase') await runGit(projectPath, ['rebase', '--abort']);
    return {
      ok: false,
      reason: 'conflict',
      conflicted,
      message:
        strategy === 'rebase'
          ? '变基拉取产生冲突，已放弃本次变基。可改用合并方式拉取，或在终端手动处理'
          : '拉取产生冲突，请在左侧列表中逐个解决',
    };
  }

  if (strategy === 'ff' && /not possible to fast-forward|diverged|have diverged/i.test(text)) {
    return {
      ok: false,
      reason: 'diverged',
      message: '本地和线上分支已分叉，需要选择合并或变基后才能继续',
    };
  }

  throw new Error(cleanError(result.error, result.stderr));
}

// 修复 branch.X.merge 重复项：保留指向本地分支的那条，其余删除
async function repairUpstream(projectPath) {
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');
  const branch = await currentBranch(projectPath);
  if (!branch) throw new Error('当前不在任何分支上，无法修复上游配置');

  const merge = await runGit(projectPath, ['config', '--get-all', `branch.${branch}.merge`]);
  const entries = merge.ok
    ? merge.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  if (entries.length <= 1) return { ok: true, branch, changed: false };

  const preferred = entries.find((entry) => entry === `refs/heads/${branch}`) || entries[0];
  await runGit(projectPath, ['config', '--unset-all', `branch.${branch}.merge`]);
  const added = await runGit(projectPath, ['config', '--add', `branch.${branch}.merge`, preferred]);
  if (!added.ok) throw new Error(cleanError(added.error, added.stderr));

  const remote = await runGit(projectPath, ['config', '--get', `branch.${branch}.remote`]);
  if (!remote.ok || !remote.stdout.trim()) {
    const remotes = await runGit(projectPath, ['remote']);
    const first = remotes.ok ? remotes.stdout.split(/\r?\n/)[0]?.trim() : '';
    if (first) await runGit(projectPath, ['config', `branch.${branch}.remote`, first]);
  }

  return { ok: true, branch, changed: true, kept: preferred };
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

// 返回统一格式的 patch 文本，由渲染侧解析成彩色视图
async function fileDiff(projectPath, filePath, changeStatus) {
  const root = path.resolve(projectPath);
  const target = resolveWithin(root, String(filePath || ''));
  const relative = path.relative(root, target);
  if (!relative) throw new Error('文件路径不在项目目录内');

  // 未跟踪文件没有可对比的 HEAD 版本。`--no-index` 搭配 NUL 在 Windows 的
  // execFile 下会 ENOENT，因此直接读文件内容，拼一份「全部新增」的 patch。
  if (changeStatus === 'untracked') {
    const content = await fsp.readFile(target, 'utf8').catch(() => '');
    const lines = content.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const header = [
      `diff --git a/${relative} b/${relative}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${relative}`,
      `@@ -0,0 +1,${lines.length} @@`,
    ];
    const patch = [...header, ...lines.map((line) => `+${line}`), ''].join('\n');
    return { patch, untracked: true };
  }

  const result = await runGit(projectPath, [
    '--no-pager',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '-U3',
    '--',
    relative,
  ]);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { patch: result.stdout, untracked: false };
}

// 最近的提交列表，供面板展示
async function log(projectPath, limit = 30) {
  const count = Math.max(1, Math.min(200, Number(limit) || 30));
  const result = await runGit(projectPath, [
    'log',
    '-' + count,
    '--pretty=format:%H' + UNIT + '%h' + UNIT + '%an' + UNIT + '%ar' + UNIT + '%s',
  ]);
  if (!result.ok) {
    // 空仓库没有 HEAD，返回空列表而不是报错
    if (/does not have any commits|unknown revision/i.test(result.stderr)) {
      return { commits: [] };
    }
    throw new Error(cleanError(result.error, result.stderr));
  }
  const commits = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(UNIT);
      return {
        hash: parts[0] || '',
        short: parts[1] || '',
        author: parts[2] || '',
        when: parts[3] || '',
        subject: parts[4] || '(无提交信息)',
      };
    });
  return { commits };
}


// 找出合并留下的冲突文件：优先看索引状态（不受输出语言影响），失败再退回解析英文输出。
async function collectConflicts(projectPath, result) {
  const current = await status(projectPath);
  const fromIndex = current.ok
    ? current.changes
        .filter((change) => change.indexStatus === 'conflicted')
        .map((change) => change.path)
    : [];
  if (fromIndex.length) return fromIndex;

  return [
    ...new Set(
      `${result.stdout}\n${result.stderr}`
        .split('\n')
        .map((line) => line.match(/(?:Merge conflict in|CONFLICT \([^)]*\):) (.+)$/))
        .filter(Boolean)
        .map((match) => match[1].trim()),
    ),
  ];
}

// 把 source 合并到 target。target 不是当前分支时先切过去，成功后切回来。
// 冲突时停在 target 上：工作区处于待解决状态，此时切走会被 git 拒绝。
async function mergeInto(projectPath, source, target) {
  const src = assertBranchName(source);
  const dst = assertBranchName(target);
  if (src === dst) throw new Error('源分支和目标分支不能相同');

  const head = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const original = head.ok ? head.stdout.trim() : '';
  const switched = Boolean(original) && original !== dst;

  if (switched) {
    const current = await status(projectPath);
    if (current.ok && (current.stagedCount > 0 || current.unstagedCount > 0)) {
      throw new Error('有未提交的改动，请先提交或放弃后再合并分支');
    }
    const co = await runGit(projectPath, ['checkout', dst]);
    if (!co.ok) throw new Error(cleanError(co.error, co.stderr));
  }

  const result = await runGit(projectPath, ['merge', src]);
  let conflicted = [];
  if (!result.ok) {
    conflicted = await collectConflicts(projectPath, result);
    if (!conflicted.length) {
      // 真正的失败（不是冲突）：尽量退回原分支再报错
      if (switched) await runGit(projectPath, ['checkout', original]);
      throw new Error(cleanError(result.error, result.stderr));
    }
  }

  let returnedTo = '';
  if (!conflicted.length && switched) {
    const back = await runGit(projectPath, ['checkout', original]);
    if (back.ok) returnedTo = original;
  }

  return {
    ok: true,
    conflicted,
    source: src,
    target: dst,
    switchedFrom: switched ? original : '',
    returnedTo,
  };
}

// 字段分隔符用不可见字符，避免提交信息里的空格干扰 split
const UNIT = String.fromCharCode(31);
const COMMIT_HASH = /^[0-9a-f]{4,40}$/;

function assertCommitHash(hash) {
  const value = String(hash || '').trim().toLowerCase();
  if (!COMMIT_HASH.test(value)) throw new Error('提交标识不合法');
  return value;
}

// 空仓库返回 null，调用方据此禁用「撤销 / 修改提交」
async function headCommit(projectPath) {
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');
  const result = await runGit(projectPath, [
    'log',
    '-1',
    `--pretty=%H${UNIT}%h${UNIT}%s${UNIT}%B`,
  ]);
  if (!result.ok) {
    if (/does not have any commits|unknown revision|bad default revision/i.test(result.stderr)) {
      return null;
    }
    throw new Error(cleanError(result.error, result.stderr));
  }
  const parts = result.stdout.split(UNIT);
  const hash = (parts[0] || '').trim();
  const short = (parts[1] || '').trim();
  const subject = (parts[2] || '').trim();
  const message = (parts.slice(3).join(UNIT) || subject).trim();

  // 无远端仓库时输出为空，pushed 为 false 是正确的
  const remote = await runGit(projectPath, [
    'branch',
    '-r',
    '--contains',
    assertCommitHash(hash),
  ]);
  return {
    hash,
    short,
    subject: subject || '(无提交信息)',
    message,
    pushed: Boolean(remote.ok && remote.stdout.trim()),
  };
}

async function undoCommit(projectPath) {
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');
  const head = await headCommit(projectPath);
  if (!head) throw new Error('还没有任何提交可以撤销');

  // 首次提交没有 HEAD~1，只能删掉引用；此时索引保留，文件仍处于已暂存状态。
  // HEAD 是符号引用时才删得到分支引用；游离 HEAD 下 update-ref -d HEAD 会删掉
  // .git/HEAD 文件本身，直接损坏仓库，因此先拒绝。
  const parent = await runGit(projectPath, ['rev-parse', '--verify', '--quiet', 'HEAD~1']);
  if (!parent.ok) {
    // 浅克隆的边界提交同样取不到 HEAD~1，不能当成「首次提交」去删分支引用
    const shallow = await runGit(projectPath, ['rev-parse', '--is-shallow-repository']);
    if (shallow.ok && shallow.stdout.trim() === 'true') {
      throw new Error('浅克隆仓库无法判断首个提交历史，未执行撤销');
    }
    const symbolic = await runGit(projectPath, ['symbolic-ref', '-q', 'HEAD']);
    if (!symbolic.ok) throw new Error('当前处于游离 HEAD 状态，无法撤销提交');
  }
  const args = parent.ok ? ['reset', '--soft', 'HEAD~1'] : ['update-ref', '-d', 'HEAD'];
  const result = await runGit(projectPath, args);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));

  return { message: head.message, wasPushed: head.pushed };
}

async function amend(projectPath, message) {
  const text = String(message || '').trim();
  if (!text) throw new Error('请填写提交信息');
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');

  const head = await headCommit(projectPath);
  if (!head) throw new Error('还没有提交可以修改');

  const current = await status(projectPath);
  const stagedCount = current.ok ? current.stagedCount : 0;
  // git commit --amend 在无改动时会静默改掉提交时间，这里先拦住
  if (text === head.message && stagedCount === 0) {
    throw new Error('提交信息未修改，也没有暂存改动');
  }

  const result = await runGit(
    projectPath,
    text === head.message
      ? ['commit', '--amend', '--no-edit']
      : ['commit', '--amend', '-m', text],
  );
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));

  const head2 = await runGit(projectPath, ['rev-parse', '--short', 'HEAD']);
  if (!head2.ok) throw new Error(cleanError(head2.error, head2.stderr));
  return { commit: head2.stdout.trim(), summary: text.split('\n')[0] };
}

const STASH_REF = /^stash@\{\d+\}$/;

function assertStashRef(ref) {
  const value = String(ref || '').trim();
  if (!STASH_REF.test(value)) throw new Error('stash 标识不合法');
  return value;
}

async function stashList(projectPath) {
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');
  const result = await runGit(projectPath, [
    'stash',
    'list',
    `--format=%gd${UNIT}%gs${UNIT}%cr`,
  ]);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  const stashes = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 20)
    .map((line) => {
      const parts = line.split(UNIT);
      return {
        ref: (parts[0] || '').trim(),
        message: (parts[1] || '').trim() || '(无说明)',
        when: (parts[2] || '').trim(),
      };
    });
  return { stashes };
}

// -u 把未跟踪文件一起收起，否则切分支时它们仍会碍事
async function stashSave(projectPath) {
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');
  const result = await runGit(projectPath, ['stash', 'push', '-u', '-m', 'Cmd Toolbox']);
  const output = `${result.stdout}${result.stderr}`;
  if (/No local changes to save/i.test(output)) throw new Error('没有可收起的改动');
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { ok: true };
}

async function stashPop(projectPath, ref) {
  const target = assertStashRef(ref);
  const result = await runGit(projectPath, ['stash', 'pop', target]);
  if (!result.ok) {
    // 冲突时 git 不会删除 stash，工作区进入冲突态：这不是失败，交给调用方提示
    const conflicts = await collectConflicts(projectPath, result);
    if (conflicts.length) return { ok: true, conflicts };
    throw new Error(cleanError(result.error, result.stderr));
  }
  return { ok: true, conflicts: [] };
}

async function stashDrop(projectPath, ref) {
  const target = assertStashRef(ref);
  const result = await runGit(projectPath, ['stash', 'drop', target]);
  if (!result.ok) throw new Error(cleanError(result.error, result.stderr));
  return { ok: true };
}

async function commitDiff(projectPath, hash) {
  const target = assertCommitHash(hash);
  if (!isDirectory(projectPath)) throw new Error('项目目录不存在');

  // 默认的 git show 对 merge commit 不输出 diff；-m --first-parent 让它相对第一父输出。
  // quotePath=false 让中文路径原样输出；diff.relative / mnemonicPrefix 会改写 a/ b/ 前缀，
  // 用户全局配置了它们时路径会残留，这里显式关掉。
  const result = await runGit(projectPath, [
    '--no-pager',
    '-c',
    'core.quotePath=false',
    '-c',
    'diff.relative=false',
    '-c',
    'diff.mnemonicPrefix=false',
    'show',
    '--no-color',
    '--no-ext-diff',
    '-U3',
    '-m',
    '--first-parent',
    '--format=',
    target,
  ]);
  if (!result.ok) {
    if (/unknown revision|bad object|invalid object name|bad revision/i.test(result.stderr)) {
      throw new Error('该提交已不在本地历史中');
    }
    throw new Error(cleanError(result.error, result.stderr));
  }
  return { patch: result.stdout };
}

module.exports = {
  log,
  status,
  commit,
  push,
  fetchRemote,
  pull,
  repairUpstream,
  cleanError,
  init,
  diffCommand,
  fileDiff,
  stage,
  unstage,
  discard,
  stageAll,
  discardAll,
  branches,
  checkout,
  createBranch,
  merge,
  mergeInto,
  headCommit,
  undoCommit,
  amend,
  stashList,
  stashSave,
  stashPop,
  stashDrop,
  commitDiff,
};
