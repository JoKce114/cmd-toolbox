const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const iconv = require('iconv-lite');
const { resolveWithin } = require('./path-guard');

const MAX_READ_BYTES = 2 * 1024 * 1024;
const IGNORED = new Set(['.git', 'node_modules', 'dist', 'release', 'release-build']);

function isIgnored(name) {
  return IGNORED.has(name) || name.startsWith('release-build');
}

async function list(projectPath, relDir) {
  const dir = resolveWithin(projectPath, relDir || '');
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const mapped = entries
    .filter((entry) => !isIgnored(entry.name))
    .map((entry) => ({
      name: entry.name,
      relPath: path.join(relDir || '', entry.name).split(path.sep).join('/'),
      isDir: entry.isDirectory(),
      isSymlink: entry.isSymbolicLink(),
    }));

  mapped.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  return { entries: mapped };
}

function detectEncoding(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { encoding: 'utf8bom', offset: 3 };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { encoding: 'utf16le', offset: 2 };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { encoding: 'utf16be', offset: 2 };
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { encoding: 'utf8', offset: 0 };
  } catch {
    return { encoding: 'gbk', offset: 0 };
  }
}

function decodeContent(buffer, encoding, offset) {
  const body = buffer.subarray(offset);
  if (encoding === 'utf8' || encoding === 'utf8bom') return body.toString('utf8');
  if (encoding === 'utf16le') return iconv.decode(body, 'utf16-le');
  if (encoding === 'utf16be') return iconv.decode(body, 'utf16-be');
  return iconv.decode(body, 'gbk');
}

function encodeContent(content, encoding) {
  if (encoding === 'utf8bom') {
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')]);
  }
  // UTF-16 仅在检测到 BOM 时才会被识别，写回时同样保留 BOM
  if (encoding === 'utf16le') {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(content, 'utf16-le')]);
  }
  if (encoding === 'utf16be') {
    return Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(content, 'utf16-be')]);
  }
  if (encoding === 'gbk') return iconv.encode(content, 'gbk');
  return Buffer.from(content, 'utf8');
}

async function read(projectPath, relPath) {
  const target = resolveWithin(projectPath, relPath);
  const stat = await fsp.stat(target);

  if (stat.size > MAX_READ_BYTES) {
    return {
      content: '',
      encoding: 'utf8',
      size: stat.size,
      readOnly: true,
      mtime: stat.mtimeMs,
    };
  }

  const buffer = await fsp.readFile(target);

  // 先做 BOM 检测：UTF-16 文本天然包含 NUL 字节，不能先按 NUL 判成二进制
  const { encoding, offset } = detectEncoding(buffer);
  const isUtf16 = encoding === 'utf16le' || encoding === 'utf16be';
  if (!isUtf16 && buffer.includes(0)) {
    return {
      content: '',
      encoding: 'utf8',
      size: stat.size,
      readOnly: true,
      mtime: stat.mtimeMs,
    };
  }

  // 疑似 GBK 时验证往返完整性；无法无损解码的文件按识别失败只读打开
  if (encoding === 'gbk') {
    const text = decodeContent(buffer, encoding, offset);
    const roundTrip = iconv.encode(text, 'gbk');
    if (
      text.includes(String.fromCharCode(0xfffd)) ||
      Buffer.compare(roundTrip, buffer.subarray(offset)) !== 0
    ) {
      return {
        content: '',
        encoding: 'utf8',
        size: stat.size,
        readOnly: true,
        mtime: stat.mtimeMs,
      };
    }
    return {
      content: text,
      encoding,
      size: stat.size,
      readOnly: false,
      mtime: stat.mtimeMs,
    };
  }

  return {
    content: decodeContent(buffer, encoding, offset),
    encoding,
    size: stat.size,
    readOnly: false,
    mtime: stat.mtimeMs,
  };
}

async function write(projectPath, relPath, content, encoding, mtime) {
  const target = resolveWithin(projectPath, relPath);
  const stat = await fsp.stat(target);

  if (typeof mtime === 'number' && Math.abs(stat.mtimeMs - mtime) > 1) {
    throw new Error('文件已在外部修改，请重新打开');
  }

  const buffer = encodeContent(String(content ?? ''), encoding || 'utf8');
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(temp, buffer);
    await fsp.rename(temp, target);
  } catch (error) {
    // 失败时别把半截临时文件留在用户项目里（writeMinified 同理）
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return { ok: true };
}

// 「文件不存在」是正常结果而不是异常，所以不抛错。
// 自动压缩要靠它判断同名 .min.js 在不在。
async function stat(projectPath, relPath) {
  const target = resolveWithin(projectPath, relPath);
  try {
    const info = await fsp.stat(target);
    if (!info.isFile()) return { exists: false, mtime: 0 };
    return { exists: true, mtime: info.mtimeMs };
  } catch (error) {
    // 只有「不存在」算正常结果；权限等其他错误照常抛出，避免静默失败
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return { exists: false, mtime: 0 };
    }
    throw error;
  }
}

// 压缩产物专用：允许创建新文件，不做 mtime 校验。
// 产物没有并发编辑的顾虑，现有 write() 因为先 stat 所以无法建新文件。
// 临时名必须唯一：同一进程里并发压缩同一文件时，共用一个 temp 会互相截断/抢 rename。
// 不用 randomUUID 是为了少一次 crypto 依赖引入，pid + 时间 + 进程内序号 + 随机数已足够。
let minifyTempSeq = 0;
function minifyTempName(target) {
  minifyTempSeq = (minifyTempSeq + 1) >>> 0;
  const random = Math.random().toString(36).slice(2, 10);
  return `${target}.${process.pid}.${Date.now()}.${minifyTempSeq}.${random}.tmp`;
}

async function writeMinified(projectPath, relPath, content) {
  const target = resolveWithin(projectPath, relPath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = minifyTempName(target);
  try {
    await fsp.writeFile(temp, String(content ?? ''), 'utf8');
    await renameWithRetry(temp, target);
  } catch (error) {
    // rename 失败时别把半截临时文件留在项目里
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return { ok: true };
}

// Windows 上 rename 覆盖正被占用/刚被替换的目标会瞬时 EPERM/EBUSY，
// 多路并发写同一产物时尤其明显。退避重试几次即可，不必让用户看到莫名失败。
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
async function renameWithRetry(temp, target) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(temp, target);
      return;
    } catch (error) {
      if (!RENAME_RETRY_CODES.has(error.code) || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

// 新建文件。用 'wx' 标志：目标已存在时抛 EEXIST，绝不覆盖用户现有文件。
async function createFile(projectPath, relPath, content = '') {
  const target = resolveWithin(projectPath, relPath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const handle = await fsp.open(target, 'wx');
  try {
    await handle.writeFile(String(content ?? ''), 'utf8');
  } finally {
    await handle.close();
  }
  return { ok: true };
}

// 新建目录。不带 recursive：同名目录已存在时要报错，而不是静默通过。
async function createDir(projectPath, relPath) {
  const target = resolveWithin(projectPath, relPath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.mkdir(target);
  return { ok: true };
}

// 移动/重命名。目标已存在时报错——粘贴和重命名都不该覆盖现有内容。
async function move(projectPath, fromRel, toRel) {
  const from = resolveWithin(projectPath, fromRel);
  const to = resolveWithin(projectPath, toRel);
  try {
    await fsp.lstat(to);
    throw new Error('目标位置已有同名项');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
  return { ok: true };
}

// 删除到系统回收站，用户可恢复。
// shell 可注入：单测不碰真实回收站，只验证调用参数。
// 注入值可以是 shell 对象，也可以直接是 trashItem 函数。
// 默认值必须懒求值：纯 Node 环境下 require('electron') 拿到的是可执行文件路径字符串。
async function trash(projectPath, relPath, shell) {
  const target = resolveWithin(projectPath, relPath);
  const impl = shell || require('electron').shell;
  const trashItem = typeof impl === 'function' ? impl : impl && impl.trashItem;
  if (typeof trashItem !== 'function') {
    throw new Error('当前环境不支持删除到回收站');
  }
  await trashItem.call(impl, target);
  return { ok: true };
}

const SEARCH_MAX_FILES = 4000;
const SEARCH_MAX_MATCHES = 500;
const SEARCH_MAX_FILE_BYTES = 1024 * 1024;

// 逐文件读取并匹配，返回带行号的结果。跳过二进制、超大文件与忽略目录。
async function search(projectPath, query, options = {}) {
  const needle = String(query || '');
  if (!needle) return { matches: [], truncated: false, scanned: 0 };

  const caseSensitive = Boolean(options.caseSensitive);
  const target = caseSensitive ? needle : needle.toLowerCase();
  const root = path.resolve(projectPath);
  const matches = [];
  let scanned = 0;
  let truncated = false;

  async function walk(relDir) {
    if (truncated) return;
    let entries;
    try {
      entries = await fsp.readdir(resolveWithin(projectPath, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (isIgnored(entry.name) || entry.isSymbolicLink()) continue;
      const relPath = path.join(relDir, entry.name).split(path.sep).join('/');
      if (entry.isDirectory()) {
        await walk(relPath);
        continue;
      }
      if (scanned >= SEARCH_MAX_FILES) {
        truncated = true;
        return;
      }
      scanned += 1;

      let stat;
      try {
        stat = await fsp.stat(path.join(root, relPath));
      } catch {
        continue;
      }
      if (stat.size > SEARCH_MAX_FILE_BYTES) continue;

      let buffer;
      try {
        buffer = await fsp.readFile(path.join(root, relPath));
      } catch {
        continue;
      }
      if (buffer.includes(0)) continue;

      const { encoding, offset } = detectEncoding(buffer);
      const text = decodeContent(buffer, encoding, offset);
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const haystack = caseSensitive ? line : line.toLowerCase();
        if (!haystack.includes(target)) continue;
        matches.push({
          relPath,
          line: index + 1,
          text: line.trim().slice(0, 200),
          column: haystack.indexOf(target) + 1,
        });
        if (matches.length >= SEARCH_MAX_MATCHES) {
          truncated = true;
          return;
        }
      }
    }
  }

  await walk('');
  return { matches, truncated, scanned };
}

module.exports = {
  list,
  read,
  write,
  stat,
  writeMinified,
  detectEncoding,
  search,
  createFile,
  createDir,
  move,
  trash,
};
