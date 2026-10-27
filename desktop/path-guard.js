const fs = require('fs');
const path = require('path');

// 解析 relPath 并确保结果落在 root 内；已存在的路径再做 realpath 校验，防符号链接逃逸。
function resolveWithin(root, relPath) {
  const base = path.resolve(root);
  const relative = String(relPath || '');
  if (relative.includes('\0')) throw new Error('路径包含非法字符');

  const target = path.resolve(base, relative);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('路径不在项目目录内');
  }

  try {
    const realBase = fs.realpathSync(base);
    const realTarget = fs.realpathSync(target);
    const realRel = path.relative(realBase, realTarget);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error('路径不在项目目录内');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return target;
}

module.exports = { resolveWithin };
