import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fileApi = require('../desktop/file-api.js');
const pathGuard = require('../desktop/path-guard.js');
const iconv = require('iconv-lite');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const repo = mkdtempSync(join(tmpdir(), 'cmdtb-fs-'));
mkdirSync(join(repo, 'src'));
writeFileSync(join(repo, 'index.php'), '<?php echo 1;\n');
writeFileSync(join(repo, 'src', 'app.js'), 'console.log(1);\n');
mkdirSync(join(repo, 'node_modules'));
writeFileSync(join(repo, 'node_modules', 'x.js'), 'x\n');

console.log('1. 列目录');
const root = await fileApi.list(repo, '');
assert(root.entries.some((e) => e.name === 'index.php' && !e.isDir), '列出根目录文件');
assert(root.entries.some((e) => e.name === 'src' && e.isDir), '目录标记为 isDir');
assert(!root.entries.some((e) => e.name === 'node_modules'), '忽略 node_modules');
assert(root.entries[0].isDir, '目录排在文件前面');
const sub = await fileApi.list(repo, 'src');
assert(sub.entries.length === 1 && sub.entries[0].relPath === 'src/app.js', '子目录 relPath 正确');

console.log('2. 读 UTF-8');
const utf8 = await fileApi.read(repo, 'index.php');
assert(utf8.content === '<?php echo 1;\n', '内容正确');
assert(utf8.encoding === 'utf8', '识别为 utf8');
assert(utf8.readOnly === false, '可写');
assert(typeof utf8.mtime === 'number' && utf8.mtime > 0, '返回 mtime');

console.log('3. 读写 GBK');
const gbkBuf = iconv.encode('中文内容\n', 'gbk');
writeFileSync(join(repo, 'gbk.txt'), gbkBuf);
const gbk = await fileApi.read(repo, 'gbk.txt');
assert(gbk.content === '中文内容\n', 'GBK 正确解码');
assert(gbk.encoding === 'gbk', '识别为 gbk');
await fileApi.write(repo, 'gbk.txt', '新的中文\n', 'gbk', gbk.mtime);
const written = readFileSync(join(repo, 'gbk.txt'));
assert(Buffer.compare(written, iconv.encode('新的中文\n', 'gbk')) === 0, '按 GBK 写回，字节一致');

console.log('4. UTF-8 BOM 往返');
writeFileSync(join(repo, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('带BOM\n')]));
const bom = await fileApi.read(repo, 'bom.txt');
assert(bom.content === '带BOM\n', 'BOM 已剥离');
assert(bom.encoding === 'utf8bom', '识别为 utf8bom');
await fileApi.write(repo, 'bom.txt', '改过\n', 'utf8bom', bom.mtime);
const bomOut = readFileSync(join(repo, 'bom.txt'));
assert(bomOut[0] === 0xef && bomOut[1] === 0xbb && bomOut[2] === 0xbf, '写回时保留 BOM');
assert(bomOut.slice(3).toString('utf8') === '改过\n', 'BOM 后内容正确');

console.log('5. 二进制只读');
writeFileSync(join(repo, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
const bin = await fileApi.read(repo, 'bin.dat');
assert(bin.readOnly === true, '二进制标记为只读');
assert(bin.content === '', '二进制不返回内容');

console.log('6. 大文件只读');
writeFileSync(join(repo, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 10));
const big = await fileApi.read(repo, 'big.txt');
assert(big.readOnly === true, '超过 2MB 只读');
assert(big.size > 2 * 1024 * 1024, '返回实际大小');

console.log('7. mtime 冲突');
const stale = await fileApi.read(repo, 'index.php');
writeFileSync(join(repo, 'index.php'), '外部改动\n');
let staleRejected = '';
try {
  await fileApi.write(repo, 'index.php', '我的改动\n', 'utf8', stale.mtime);
} catch (error) {
  staleRejected = error.message;
}
assert(staleRejected.includes('外部'), 'mtime 不匹配时拒绝写入');
assert(readFileSync(join(repo, 'index.php'), 'utf8') === '外部改动\n', '原文件未被覆盖');

console.log('8. 路径越界');
for (const bad of ['../outside.txt', 'src/../../x.txt', '/etc/passwd']) {
  let rejected = false;
  try {
    pathGuard.resolveWithin(repo, bad);
  } catch {
    rejected = true;
  }
  assert(rejected, `拒绝路径 ${bad}`);
}
let readRejected = false;
try {
  await fileApi.read(repo, '../outside.txt');
} catch {
  readRejected = true;
}
assert(readRejected, 'read 拒绝越界路径');

console.log(`\n全部通过：${passed} 项`);
