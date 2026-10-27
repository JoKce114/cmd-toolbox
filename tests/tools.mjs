import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listTools, resolveShell } = require('../desktop/shells.js');

let passed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

const tools = listTools();
assert(tools.length === 5, '工具列表是 5 项');
assert(
  tools.every((tool) => ['grok', 'codex', 'claude', 'gemini', 'opencode'].includes(tool.id)),
  '工具 id 是 grok/codex/claude/gemini/opencode',
);
assert(
  tools.every((tool) => typeof tool.available === 'boolean'),
  '每项都有 available',
);
assert(
  tools.filter((tool) => !tool.available).every((tool) => tool.hint.includes('未安装')),
  '未安装的项带提示',
);

let unknownFailed = false;
try {
  resolveShell('not-a-real-shell');
} catch {
  unknownFailed = true;
}
assert(unknownFailed, '未知类型会报错');

const cmd = resolveShell('cmd');
assert(cmd.id === 'cmd' && cmd.file, 'cmd 可以解析');

const installed = tools.filter((tool) => tool.available);
for (const tool of installed) {
  const resolved = resolveShell(tool.id);
  assert(resolved.id === tool.id && resolved.file, `已安装的 ${tool.label} 可以解析`);
  const joined = [resolved.file, ...resolved.args].join(' ');
  assert(!/(^|[\\/])(grok|codex|claude|gemini|opencode)$/i.test(resolved.file), `${tool.label} 不使用无后缀脚本`);
  assert(
    /\.exe$/i.test(resolved.file) || joined.toLowerCase().includes('.cmd') || joined.toLowerCase().includes('.bat'),
    `${tool.label} 用 exe 或 cmd 启动`,
  );
  if (tool.id === 'claude') {
    assert(
      joined.includes('--dangerously-skip-permissions'),
      'Claude 带上跳过权限参数',
    );
  }
}

const grokResume = resolveShell('grok', { resume: true });
assert(
  [grokResume.file, ...grokResume.args].join(' ').includes('--continue'),
  'Grok 恢复时使用 --continue',
);
const grokResumeId = resolveShell('grok', { resume: true, resumeId: 'abc-123' });
const grokResumeJoined = [grokResumeId.file, ...grokResumeId.args].join(' ');
assert(
  grokResumeJoined.includes('--resume') && grokResumeJoined.includes('abc-123'),
  'Grok 恢复指定会话',
);
const claudeResume = resolveShell('claude', { resume: true });
const claudeJoined = [claudeResume.file, ...claudeResume.args].join(' ');
assert(
  claudeJoined.includes('--continue') && claudeJoined.includes('--dangerously-skip-permissions'),
  'Claude 恢复时继续对话并跳过权限',
);
const codexResume = resolveShell('codex', { resume: true });
const codexJoined = [codexResume.file, ...codexResume.args].join(' ');
assert(
  codexJoined.includes('resume') && codexJoined.includes('--last'),
  'Codex 恢复最近一次会话',
);

console.log(`tools ${passed} passed`);
for (const tool of tools) {
  console.log(`  ${tool.available ? 'ready' : 'missing'}  ${tool.label}${tool.hint ? `  (${tool.hint})` : ''}`);
}
