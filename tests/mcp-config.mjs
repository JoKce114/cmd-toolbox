// 离线验证 mcp-config 的写入行为：不碰真实用户目录，全部在临时 HOME 里跑。
import assert from 'node:assert';
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mcpcfg-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const { installGlobal } = await import('../desktop/mcp-config.js');

let passed = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  passed += 1;
  console.log('  ok  ' + msg);
};

const URL_A = 'http://127.0.0.1:17382/mcp?token=' + 'a'.repeat(32);
const URL_B = 'http://127.0.0.1:17382/mcp?token=' + 'b'.repeat(32);

const files = {
  mcpJson: join(home, '.mcp.json'),
  claudeJson: join(home, '.claude.json'),
  grokToml: join(home, '.grok', 'config.toml'),
  codexToml: join(home, '.codex', 'config.toml'),
  geminiJson: join(home, '.gemini', 'settings.json'),
  opencodeJson: join(home, '.config', 'opencode', 'opencode.jsonc'),
  skill: join(home, '.grok', 'skills', 'cmd-toolbox-panes', 'SKILL.md'),
};

console.log('1. 首次写入会创建文件');
installGlobal({ mcpUrl: URL_A });
for (const name of ['mcpJson', 'grokToml', 'codexToml', 'geminiJson', 'opencodeJson', 'skill']) {
  ok(existsSync(files[name]), `${name} 已创建`);
}
// .claude.json 只更新不创建：没用过 Claude Code 的人不该被凭空塞一个配置
ok(!existsSync(files.claudeJson), '.claude.json 未凭空创建');
ok(readFileSync(files.mcpJson, 'utf8').includes(URL_A), '.mcp.json 含本次地址');

console.log('2. 用户自己的配置不会被吃掉');
writeFileSync(
  files.grokToml,
  '[my_own]\nkeep = "me"\n\n[mcp_servers.cmdtoolbox]\nurl = ' +
    JSON.stringify(URL_A) +
    '\ntype = "http"\nenabled = true\n',
);
writeFileSync(
  files.claudeJson,
  JSON.stringify({ otherTool: { keep: true }, mcpServers: {} }, null, 2) + '\n',
);
installGlobal({ mcpUrl: URL_A });
const grokText = readFileSync(files.grokToml, 'utf8');
ok(grokText.includes('[my_own]') && grokText.includes('keep = "me"'), 'TOML 里的其他段保留');
const claudeData = JSON.parse(readFileSync(files.claudeJson, 'utf8'));
ok(claudeData.otherTool && claudeData.otherTool.keep === true, 'JSON 里的其他键保留');
ok(claudeData.mcpServers.cmdtoolbox.url === URL_A, 'JSON 里的 cmdtoolbox 条目已写入');

console.log('3. 内容没变时不再重写（修改时间不变）');
const before = Object.fromEntries(
  Object.entries(files).map(([name, file]) => [
    name,
    existsSync(file) ? statSync(file).mtimeMs : null,
  ]),
);
installGlobal({ mcpUrl: URL_A });
let unchanged = 0;
let present = 0;
for (const [name, file] of Object.entries(files)) {
  if (!existsSync(file)) continue;
  present += 1;
  if (statSync(file).mtimeMs === before[name]) unchanged += 1;
}
ok(present > 0 && unchanged === present, `全部 ${unchanged} 个已存在的文件均未被重写`);

console.log('4. 地址变了才会重写');
installGlobal({ mcpUrl: URL_B });
ok(readFileSync(files.mcpJson, 'utf8').includes(URL_B), '.mcp.json 更新为新地址');
ok(!readFileSync(files.mcpJson, 'utf8').includes(URL_A), '.mcp.json 不再含旧地址');
ok(readFileSync(files.grokToml, 'utf8').includes(URL_B), 'TOML 更新为新地址');
ok(readFileSync(files.grokToml, 'utf8').includes('[my_own]'), '更新时其他段仍然保留');

console.log('5. 文件被删掉会重建');
const { rmSync } = await import('node:fs');
rmSync(files.geminiJson);
installGlobal({ mcpUrl: URL_B });
ok(existsSync(files.geminiJson), '缺失的文件被重新创建');

console.log(`\n全部通过：${passed} 项`);
