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
  if (encoding === 'utf16le') return iconv.encode(content, 'utf16-le');
  if (encoding === 'utf16be') return iconv.encode(content, 'utf16-be');
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
  if (buffer.includes(0)) {
    return {
      content: '',
      encoding: 'utf8',
      size: stat.size,
      readOnly: true,
      mtime: stat.mtimeMs,
    };
  }

  const { encoding, offset } = detectEncoding(buffer);
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
  await fsp.writeFile(temp, buffer);
  await fsp.rename(temp, target);
  return { ok: true };
}

module.exports = { list, read, write, detectEncoding };
