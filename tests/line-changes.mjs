// 行级变更计算。离线可跑，不依赖 GUI。
import { registerHooks } from 'node:module';

// 源码沿用仓库的无扩展名相对导入，而 Node 直接跑 .ts 时要求写明扩展名。
// 这里补一个解析钩子，只在测试进程里把 './xxx' 补成 './xxx.ts'。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/i.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const { computeLineChanges } = await import('../src/lineChanges.ts');

const base = ['a', 'b', 'c', 'd', 'e'].join('\n');

console.log('1. 无改动');
{
  const changes = computeLineChanges(base, base);
  assert(changes.chunks.length === 0, '相同内容没有变更块');
  assert(changes.deletes.length === 0, '相同内容没有删除锚点');
  assert(changes.totalLines === 5, 'totalLines 为 5');
}

console.log('2. 纯新增');
{
  const next = ['a', 'b', 'X', 'c', 'd', 'e'].join('\n');
  const changes = computeLineChanges(base, next);
  assert(changes.chunks.length === 1, '一个变更块');
  assert(changes.chunks[0].kind === 'added', '类型是 added');
  assert(changes.chunks[0].startLine === 3 && changes.chunks[0].endLine === 3, '落在第 3 行');
  assert(changes.deletes.length === 0, '没有删除锚点');
}

console.log('3. 纯删除');
{
  const next = ['a', 'b', 'd', 'e'].join('\n');
  const changes = computeLineChanges(base, next);
  assert(changes.chunks.length === 0, '纯删除不产生色条');
  assert(changes.deletes.length === 1, '一个删除锚点');
  assert(changes.deletes[0].texts.join('|') === 'c', '锚点带出被删原文');
  assert(changes.deletes[0].line === 3, '锚点在第 3 行（删除位置之后那一行）');
}

console.log('4. 一行改一行');
{
  const next = ['a', 'b', 'C', 'd', 'e'].join('\n');
  const changes = computeLineChanges(base, next);
  assert(changes.chunks.length === 1 && changes.chunks[0].kind === 'modified', '类型是 modified');
  assert(changes.chunks[0].startLine === 3, '落在第 3 行');
  assert(changes.deletes.length === 1, '同时有删除锚点');
  assert(changes.deletes[0].line === 3, '锚点在第 3 行');
}

console.log('5. 改一行加两行');
{
  // Myers 的最短解是 delete c + insert C,D,F（4 次编辑），只把 c 当被替换的那行，
  // 多出来的 D、F 算新增。不要按「c,d 都被替换」去期望，那是非最短差分。
  const next = ['a', 'b', 'C', 'D', 'F', 'd', 'e'].join('\n');
  const changes = computeLineChanges(base, next);
  const modified = changes.chunks.filter((chunk) => chunk.kind === 'modified');
  const added = changes.chunks.filter((chunk) => chunk.kind === 'added');
  assert(modified.length === 1 && modified[0].startLine === 3, '第 3 行算修改');
  assert(added.length === 1 && added[0].startLine === 4, '第 4、5 行算新增');
  assert(added[0].endLine === 5, '新增到第 5 行');
  assert(changes.deletes[0].line === 3, '锚点在块首行');
}

console.log('6. 文件开头删除');
{
  const changes = computeLineChanges('a\nb', 'b');
  assert(changes.deletes[0].line === 1, '锚点钳到第 1 行');
}

console.log('7. 文件末尾删除');
{
  const changes = computeLineChanges('a\nb\nc', 'a\nb');
  assert(changes.deletes[0].line === 2, '锚点钳到最后一行');
}

console.log('8. 空文件');
{
  const changes = computeLineChanges('', 'a\nb');
  assert(changes.totalLines === 2, 'totalLines 为 2');
  assert(changes.chunks.length === 1 && changes.chunks[0].kind === 'added', '整篇算新增');
  const emptied = computeLineChanges('a\nb', '');
  assert(emptied.chunks.length === 0, '清空文件不产生色条');
  assert(emptied.deletes.length === 1, '清空文件有一个锚点');
}

console.log('9. 末尾换行不算一行');
{
  const changes = computeLineChanges('a\nb\n', 'a\nb\n');
  assert(changes.totalLines === 2, '末尾换行不额外算一行');
}

console.log('10. 超大文件直接放弃');
{
  const big = Array.from({ length: 15000 }, (_, index) => `line${index}`).join('\n');
  const bigNext = big + '\nextra';
  const changes = computeLineChanges(big, bigNext);
  assert(changes.chunks.length === 0 && changes.deletes.length === 0, '超过 20000 行返回空结果');
}

console.log(`\n全部通过：${passed} 项`);
