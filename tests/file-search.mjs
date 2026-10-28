import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fileApi = require('../desktop/file-api.js');

let passed = 0;
const assert = (c, m) => { if (!c) throw new Error('断言失败：' + m); passed += 1; console.log('  ok  ' + m); };

const repo = mkdtempSync(join(tmpdir(), 's-'));
mkdirSync(join(repo, 'src'));
mkdirSync(join(repo, 'node_modules'));
writeFileSync(join(repo, 'a.php'), '<?php\nfunction hello() {}\n');
writeFileSync(join(repo, 'src/b.js'), 'const hello = 1;\n// hello world\n');
writeFileSync(join(repo, 'src/c.txt'), 'nothing here\n');
writeFileSync(join(repo, 'node_modules/x.js'), 'hello\n');
writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 104, 101, 108, 108, 111]));

console.log('1. 基本搜索');
const r1 = await fileApi.search(repo, 'hello');
assert(r1.matches.length === 3, '找到 3 处（忽略 node_modules 与二进制）');
assert(r1.matches.some((m) => m.relPath === 'a.php' && m.line === 2), 'a.php 第 2 行');
assert(r1.matches.some((m) => m.relPath === 'src/b.js' && m.line === 2), 'src/b.js 第 2 行');
assert(!r1.matches.some((m) => m.relPath.includes('node_modules')), '跳过 node_modules');
assert(!r1.matches.some((m) => m.relPath === 'bin.dat'), '跳过二进制');

console.log('2. 大小写');
const lower = await fileApi.search(repo, 'HELLO');
assert(lower.matches.length === 3, '默认不区分大小写');
const strict = await fileApi.search(repo, 'HELLO', { caseSensitive: true });
assert(strict.matches.length === 0, '区分大小写时无匹配');

console.log('3. 空查询');
const empty = await fileApi.search(repo, '   ');
assert(empty.matches.length === 0, '空查询返回空');

console.log('4. 无匹配');
const none = await fileApi.search(repo, 'zzzz-not-exist');
assert(none.matches.length === 0, '无匹配返回空');

console.log(`\n全部通过：${passed} 项`);
