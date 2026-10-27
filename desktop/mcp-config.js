const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI_IDS = new Set(['grok', 'codex', 'claude', 'gemini', 'opencode']);

function quoteToml(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function cmdtoolboxToml(mcpUrl) {
  return [
    '[mcp_servers.cmdtoolbox]',
    `url = ${quoteToml(mcpUrl)}`,
    'type = "http"',
    'enabled = true',
    '',
  ].join('\n');
}

function upsertTomlSection(file, mcpUrl, disableCcpanes) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  let next = text
    .replace(/\n?\[mcp_servers\.cmdtoolbox(?:\.[^\]]*)?\][\s\S]*?(?=\n\[|\s*$)/g, '')
    .trimEnd();
  if (disableCcpanes) {
    next = next
      .replace(/\n?\[mcp_servers\.ccpanes(?:\.[^\]]*)?\][\s\S]*?(?=\n\[|\s*$)/g, '')
      .trimEnd();
    next = `${next}${next ? '\n\n' : ''}[mcp_servers.ccpanes]\nenabled = false\n`;
  }
  next = `${next}${next ? '\n\n' : ''}${cmdtoolboxToml(mcpUrl).trim()}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
}

function parseJsonFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const data = JSON.parse(text || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function upsertMcpJson(file, mcpUrl) {
  const data = parseJsonFile(file);
  if (!data.mcpServers || typeof data.mcpServers !== 'object') data.mcpServers = {};
  data.mcpServers.cmdtoolbox = {
    type: 'http',
    url: mcpUrl,
  };
  writeJson(file, data);
}

function upsertClaudeJson(file, mcpUrl) {
  if (!fs.existsSync(file)) return;
  const data = parseJsonFile(file);
  if (!data.mcpServers || typeof data.mcpServers !== 'object') data.mcpServers = {};
  data.mcpServers.cmdtoolbox = {
    type: 'http',
    url: mcpUrl,
  };
  writeJson(file, data);
}

function upsertGeminiJson(file, mcpUrl) {
  const data = parseJsonFile(file);
  if (!data.mcpServers || typeof data.mcpServers !== 'object') data.mcpServers = {};
  data.mcpServers.cmdtoolbox = {
    httpUrl: mcpUrl,
    timeout: 60000,
  };
  writeJson(file, data);
}

function upsertOpencodeJson(file, mcpUrl) {
  const data = parseJsonFile(file);
  if (!data.$schema) data.$schema = 'https://opencode.ai/config.json';
  if (!data.mcp || typeof data.mcp !== 'object') data.mcp = {};
  data.mcp.cmdtoolbox = {
    type: 'remote',
    url: mcpUrl,
  };
  writeJson(file, data);
}

function writePaneSkill() {
  const dir = path.join(os.homedir(), '.grok', 'skills', 'cmd-toolbox-panes');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  const body = [
    '---',
    'name: cmd-toolbox-panes',
    'description: Use when the user mentions Cmd Toolbox, pane numbers like #1 #2 #3, 窗口, 浏览器页签, or asks to look at another terminal/browser in this desktop. Always call cmdtoolbox MCP tools. Never ccpanes. Never download HTML or write Python parsers for this.',
    '---',
    '',
    '用户在 Cmd Toolbox 里说「#2 窗口」时：',
    '',
    '1. 先调用 `list_panes`（cmdtoolbox），不要调用 ccpanes。',
    '2. 再调用 `get_pane_content`，pane 填 `#2`。',
    '3. 要点击、跳转、输入时用 `browser_click` / `browser_navigate` / `browser_type`。',
    '4. 禁止为了看页面去下载 HTML 或编写 `.py` 解析。',
    '',
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
}

function installGlobal(info) {
  if (!info || !info.mcpUrl) return;
  const home = os.homedir();
  const url = info.mcpUrl;
  upsertMcpJson(path.join(home, '.mcp.json'), url);
  upsertTomlSection(path.join(home, '.grok', 'config.toml'), url, false);
  upsertTomlSection(path.join(home, '.codex', 'config.toml'), url, false);
  upsertClaudeJson(path.join(home, '.claude.json'), url);
  upsertGeminiJson(path.join(home, '.gemini', 'settings.json'), url);
  upsertOpencodeJson(path.join(home, '.config', 'opencode', 'opencode.jsonc'), url);
  writePaneSkill();
}

function installForProject(cwd, info) {
  if (!cwd || !info || !info.mcpUrl) return;
  try {
    const resolved = path.resolve(cwd);
    const windows = process.env.SystemRoot || 'C:\\Windows';
    if (resolved.toLowerCase().startsWith(String(windows).toLowerCase())) return;
    upsertTomlSection(path.join(resolved, '.grok', 'config.toml'), info.mcpUrl, true);
  } catch (error) {
    console.warn('写入项目 Grok MCP 配置失败:', error.message);
  }
}

function isCliTool(shellId) {
  return CLI_IDS.has(shellId);
}

module.exports = { installGlobal, installForProject, isCliTool };
