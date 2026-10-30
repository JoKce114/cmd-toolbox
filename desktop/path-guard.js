const fs = require('fs');
const path = require('path');

// rel 为 '..' 或 '..' + 分隔符开头才算越界；`..notes` 是合法文件名。
function isOutside(rel) {
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
}

// 解析 relPath 并确保结果落在 root 内；已存在的路径再做 realpath 校验，防符号链接逃逸。
function resolveWithin(root, relPath) {
  const base = path.resolve(root);
  const relative = String(relPath || '');
  if (relative.includes('\0')) throw new Error('路径包含非法字符');

  const target = path.resolve(base, relative);
  const rel = path.relative(base, target);
  if (isOutside(rel)) {
    throw new Error('路径不在项目目录内');
  }

  let realBase;
  try {
    realBase = fs.realpathSync(base);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // 项目根目录本身还不存在，无从比较真实路径
    return target;
  }

  // 自身抛出的越界错误没有 code，因此不会被下面的 ENOENT 分支吞掉
  function assertRealInside(candidate) {
    const realCandidate = fs.realpathSync(candidate);
    const realRel = path.relative(realBase, realCandidate);
    if (isOutside(realRel)) {
      throw new Error('路径不在项目目录内');
    }
  }

  try {
    assertRealInside(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // target 还不存在：退回校验最近的已存在祖先目录。否则「项目内的链接指向项目外」时，
    // 新建文件的词法路径虽在项目内，realpath 校验却会因 ENOENT 被跳过，
    // 随后 mkdir(recursive) 会顺着链接在项目外建目录并写入。
    let ancestor = path.dirname(target);
    while (ancestor.length >= base.length) {
      try {
        assertRealInside(ancestor);
        break;
      } catch (inner) {
        if (inner.code !== 'ENOENT') throw inner;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
    }
  }

  return target;
}

module.exports = { resolveWithin };
