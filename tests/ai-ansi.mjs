import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cleanOutput, stripAnsi } = require('../desktop/ai-tools/ansi.js');

let passed = 0;
const assert = (cond, msg) => {
  if (!cond) throw new Error(`断言失败：${msg}`);
  passed += 1;
  console.log('  ok  ' + msg);
};

console.log('1. 剥离 CSI 颜色序列');
assert(stripAnsi('\x1b[32mhello\x1b[0m') === 'hello', '颜色被剥掉');
assert(stripAnsi('\x1b[1;31mred\x1b[0m') === 'red', '组合样式被剥掉');

console.log('2. 剥离 OSC 序列（终端标题）');
assert(stripAnsi('\x1b]0;title\x07text') === 'text', 'OSC 被剥掉');

console.log('3. 回车覆盖只保留最后一次');
assert(cleanOutput('10%\r50%\r100%\n') === '100%', '同一行被覆盖成最后结果');

console.log('4. 多行里的回车覆盖');
assert(cleanOutput('a\n10%\r99%\nb\n') === 'a\n99%\nb', '只覆盖所在行');

console.log('5. 尾部空行被裁剪');
assert(cleanOutput('hello\n\n\n') === 'hello', '尾部空行被去掉');
assert(cleanOutput('hello   \n') === 'hello', '行尾空白被去掉');

console.log('6. 连续空行折叠为一行');
assert(cleanOutput('a\n\n\n\nb\n') === 'a\n\nb', '连续空行折叠');

console.log('7. 空输入');
assert(cleanOutput('') === '', '空字符串原样返回');

console.log('8. 退格删除前一个字符');
assert(cleanOutput('abc\x08d\n') === 'abd', '退格生效');

console.log('9. CRLF 换行（Windows pty）');
assert(cleanOutput('a\r\nb\r\n') === 'a\nb', 'CRLF 换行正常分列');
assert(cleanOutput('10%\r50%\r100%\r\n') === '100%', 'CRLF 与回车覆盖组合');

console.log(`\n全部通过：${passed} 项`);
