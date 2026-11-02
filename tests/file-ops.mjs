// 文件操作层：新建、新建目录、移动、删除。
// 全部使用临时目录，不碰真实项目与真实回收站。
import { createRequire } from 'node:module';
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const fileApi = require('../desktop/file-api.js');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const dir = mkdtempSync(join(tmpdir(), 'cmdtb-fileops-'));

try {
  console.log('1. createFile');
  await fileApi.createFile(dir, 'new.txt', 'hello');
  assert(readFileSync(join(dir, 'new.txt'), 'utf8') === 'hello', '内容写入正确');

  // 关键：同名文件绝不能被覆盖
  let overwrote = false;
  try {
    await fileApi.createFile(dir, 'new.txt', 'OTHER');
  } catch {
    overwrote = true;
  }
  assert(overwrote, '同名文件创建时报错');
  assert(readFileSync(join(dir, 'new.txt'), 'utf8') === 'hello', '原文件内容未被覆盖');

  console.log('2. createFile 自动创建父目录');
  await fileApi.createFile(dir, 'sub/deep/a.txt', 'x');
  assert(existsSync(join(dir, 'sub/deep/a.txt')), '父目录自动创建');

  console.log('3. createDir');
  await fileApi.createDir(dir, 'folder');
  assert(existsSync(join(dir, 'folder')), '目录创建成功');
  let dirDup = false;
  try {
    await fileApi.createDir(dir, 'folder');
  } catch {
    dirDup = true;
  }
  assert(dirDup, '同名目录创建时报错');

  console.log('4. move');
  writeFileSync(join(dir, 'src.txt'), 'MOVE_ME', 'utf8');
  await fileApi.move(dir, 'src.txt', 'dst.txt');
  assert(!existsSync(join(dir, 'src.txt')), '原位置消失');
  assert(readFileSync(join(dir, 'dst.txt'), 'utf8') === 'MOVE_ME', '新位置内容正确');

  // 目标已存在时不能覆盖
  writeFileSync(join(dir, 'occupied.txt'), 'KEEP', 'utf8');
  writeFileSync(join(dir, 'willmove.txt'), 'MOVER', 'utf8');
  let moveDup = false;
  try {
    await fileApi.move(dir, 'willmove.txt', 'occupied.txt');
  } catch {
    moveDup = true;
  }
  assert(moveDup, '目标已存在时移动报错');
  assert(readFileSync(join(dir, 'occupied.txt'), 'utf8') === 'KEEP', '目标文件未被覆盖');

  console.log('5. 路径逃逸被拒');
  for (const [label, fn] of [
    ['createFile ../evil', () => fileApi.createFile(dir, '../evil.txt', 'x')],
    ['createDir ../evil', () => fileApi.createDir(dir, '../evildir')],
    ['copy 源路径越界', () => fileApi.copy(dir, '../evil.txt', 'copy-ok.txt')],
    ['copy 目标越界', () => fileApi.copy(dir, 'dst.txt', '../evil.txt')],
    ['move 源路径越界', () => fileApi.move(dir, '../evil.txt', 'ok.txt')],
    ['move 目标越界', () => fileApi.move(dir, 'dst.txt', '../evil.txt')],
    ['trash 越界', () => fileApi.trash(dir, '../evil.txt', async () => {})],
  ]) {
    let rejected = false;
    try {
      await fn();
    } catch {
      rejected = true;
    }
    assert(rejected, `${label} 被拒绝`);
  }

  console.log('6. trash 调用注入的 shell');
  const calls = [];
  writeFileSync(join(dir, 'trashme.txt'), 'BYE', 'utf8');
  await fileApi.trash(dir, 'trashme.txt', async (target) => {
    calls.push(target);
  });
  assert(calls.length === 1, `shell.trashItem 被调用一次，实际 ${calls.length}`);
  assert(calls[0].endsWith('trashme.txt'), `传入了正确路径，实际 ${calls[0]}`);

  console.log('7. move 目录');
  mkdirSync(join(dir, 'd1'), { recursive: true });
  writeFileSync(join(dir, 'd1/f.txt'), 'IN', 'utf8');
  await fileApi.move(dir, 'd1', 'd2');
  assert(existsSync(join(dir, 'd2/f.txt')), '目录移动后内容仍在');
  assert(!existsSync(join(dir, 'd1')), '原目录消失');

  console.log('8. move 仅改大小写');
  writeFileSync(join(dir, 'case.txt'), 'CASE_DATA', 'utf8');
  await fileApi.move(dir, 'case.txt', 'CASE.txt');
  assert(readFileSync(join(dir, 'CASE.txt'), 'utf8') === 'CASE_DATA', '大小写重命名后内容不变');
  const names = readdirSync(dir);
  assert(names.includes('CASE.txt'), '目录项已使用新的大小写');
  assert(!names.includes('case.txt'), '旧大小写不再出现');

  console.log('9. move 目标为已存在目录时报错');
  mkdirSync(join(dir, 'targetDir'));
  writeFileSync(join(dir, 'file-for-dir.txt'), 'X', 'utf8');
  let dirTarget = false;
  try {
    await fileApi.move(dir, 'file-for-dir.txt', 'targetDir');
  } catch {
    dirTarget = true;
  }
  assert(dirTarget, '目标为目录时移动报错');
  assert(existsSync(join(dir, 'file-for-dir.txt')), '源文件保持原位');

  console.log('10. copy 文件');
  writeFileSync(join(dir, 'copy-src.txt'), 'COPY_DATA', 'utf8');
  await fileApi.copy(dir, 'copy-src.txt', 'copy-dst.txt');
  assert(existsSync(join(dir, 'copy-src.txt')), '复制后源文件仍在');
  assert(readFileSync(join(dir, 'copy-dst.txt'), 'utf8') === 'COPY_DATA', '副本内容一致');
  assert(readFileSync(join(dir, 'copy-src.txt'), 'utf8') === 'COPY_DATA', '源文件内容不变');

  console.log('11. copy 目录（含嵌套文件）');
  mkdirSync(join(dir, 'copy-dir/nested'), { recursive: true });
  writeFileSync(join(dir, 'copy-dir/a.txt'), 'A', 'utf8');
  writeFileSync(join(dir, 'copy-dir/nested/b.txt'), 'B', 'utf8');
  await fileApi.copy(dir, 'copy-dir', 'copied-dir');
  assert(existsSync(join(dir, 'copy-dir/a.txt')), '目录复制后源目录仍在');
  assert(readFileSync(join(dir, 'copied-dir/a.txt'), 'utf8') === 'A', '目录内文件已复制');
  assert(
    readFileSync(join(dir, 'copied-dir/nested/b.txt'), 'utf8') === 'B',
    '嵌套文件已复制',
  );

  console.log('12. copy 目标已存在时报错');
  writeFileSync(join(dir, 'copy-occupied.txt'), 'KEEP', 'utf8');
  writeFileSync(join(dir, 'copy-blocked.txt'), 'BLOCKED', 'utf8');
  let copyDup = false;
  try {
    await fileApi.copy(dir, 'copy-blocked.txt', 'copy-occupied.txt');
  } catch {
    copyDup = true;
  }
  assert(copyDup, '目标已存在时复制报错');
  assert(readFileSync(join(dir, 'copy-occupied.txt'), 'utf8') === 'KEEP', '目标文件未被覆盖');
  assert(
    readFileSync(join(dir, 'copy-blocked.txt'), 'utf8') === 'BLOCKED',
    '源文件未被破坏',
  );
  assert(existsSync(join(dir, 'copy-blocked.txt')), '冲突时源文件仍在原位');

  console.log('13. copy 到不存在的深层路径');
  await fileApi.copy(dir, 'copy-src.txt', 'deep/a/b/copied.txt');
  assert(existsSync(join(dir, 'deep/a/b/copied.txt')), '父目录被自动创建');
  assert(
    readFileSync(join(dir, 'deep/a/b/copied.txt'), 'utf8') === 'COPY_DATA',
    '深层路径副本内容一致',
  );

  console.log('14. copy 失败后目标原有内容不变');
  mkdirSync(join(dir, 'copy-existing-dir'), { recursive: true });
  writeFileSync(join(dir, 'copy-existing-dir/keep.txt'), 'KEEP_DIR', 'utf8');
  let copyDirDup = false;
  try {
    await fileApi.copy(dir, 'copy-dir', 'copy-existing-dir');
  } catch {
    copyDirDup = true;
  }
  assert(copyDirDup, '目标目录已存在时复制报错');
  assert(
    readFileSync(join(dir, 'copy-existing-dir/keep.txt'), 'utf8') === 'KEEP_DIR',
    '目标目录原有内容未被改动',
  );
  assert(!existsSync(join(dir, 'copy-existing-dir/a.txt')), '未在目标目录里留下半拷贝');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n全部通过：${passed} 项`);
