#!/usr/bin/env node
const http = require('http');

const base = String(process.env.CMDTOOLBOX_MCP_URL || '').replace(/\/$/, '');
const token = String(process.env.CMDTOOLBOX_MCP_TOKEN || '');

const TOOLS = [
  {
    name: 'list_panes',
    description:
      '列出 Cmd Toolbox 当前工作台的窗格。页签最前面的 #1 #2 就是这里的编号。查看或操作浏览器请用这些工具，不要调用 ccpanes。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_pane_content',
    description:
      '读取 Cmd Toolbox 某个窗格的内容。浏览器返回页面可见文字，终端返回最近输出。pane 填 2 或 #2。',
    inputSchema: {
      type: 'object',
      properties: { pane: { type: 'string', description: '窗格编号，如 #2' } },
      required: ['pane'],
    },
  },
  {
    name: 'browser_navigate',
    description: '让 Cmd Toolbox 里指定编号的浏览器跳转到 http/https 地址。',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string', description: '浏览器窗格编号，如 #2' },
        url: { type: 'string' },
      },
      required: ['pane', 'url'],
    },
  },
  {
    name: 'browser_click',
    description: '点击 Cmd Toolbox 浏览器元素。优先传 index（get_pane_content 返回的编号）。',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string' },
        index: { type: 'number' },
        selector: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['pane'],
    },
  },
  {
    name: 'browser_type',
    description: '在 Cmd Toolbox 指定浏览器里输入文字。可传 CSS selector 定位输入框。',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string' },
        text: { type: 'string' },
        selector: { type: 'string' },
      },
      required: ['pane', 'text'],
    },
  },
  {
    name: 'browser_screenshot',
    description: '截取 Cmd Toolbox 指定浏览器窗格，返回 PNG 文件路径。',
    inputSchema: {
      type: 'object',
      properties: { pane: { type: 'string' } },
      required: ['pane'],
    },
  },
];

function send(message) {
  const json = JSON.stringify(message);
  const payload = Buffer.from(json, 'utf8');
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    if (!base) {
      reject(new Error('Cmd Toolbox 接口未启动'));
      return;
    }
    const url = new URL(pathname, `${base}/`);
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(data
            ? { 'Content-Type': 'application/json', 'Content-Length': data.length }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            const parsed = JSON.parse(text || '{}');
            if (res.statusCode >= 400) {
              reject(new Error(parsed.error || text || `HTTP ${res.statusCode}`));
              return;
            }
            resolve(parsed);
          } catch {
            reject(new Error(text || `HTTP ${res.statusCode}`));
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function callTool(name, args) {
  const pane = args && args.pane;
  if (name === 'list_panes') return request('GET', '/panes');
  if (name === 'get_pane_content') return request('GET', `/panes/${encodeURIComponent(pane)}/content`);
  if (name === 'browser_screenshot') {
    return request('GET', `/panes/${encodeURIComponent(pane)}/screenshot`);
  }
  if (name === 'browser_navigate') {
    return request('POST', `/panes/${encodeURIComponent(pane)}/navigate`, { url: args.url });
  }
  if (name === 'browser_click') {
    return request('POST', `/panes/${encodeURIComponent(pane)}/click`, {
      x: args.x,
      y: args.y,
      index: args.index,
      selector: args.selector,
    });
  }
  if (name === 'browser_type') {
    return request('POST', `/panes/${encodeURIComponent(pane)}/type`, {
      text: args.text,
      selector: args.selector,
    });
  }
  throw new Error(`未知工具：${name}`);
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
    return;
  }
  if (typeof message.id === 'undefined') return;
  try {
    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'cmdtoolbox', version: '1.0.0' },
        },
      });
      return;
    }
    if (message.method === 'tools/list' || message.method === 'tools/listChanged') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
      return;
    }
    if (message.method === 'ping') {
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    }
    if (message.method === 'tools/call') {
      const name = message.params && message.params.name;
      const args = (message.params && message.params.arguments) || {};
      const result = await callTool(name, args);
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `未知方法：${message.method}` },
    });
  } catch (error) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: error.message || String(error) }],
        isError: true,
      },
    });
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    const lineEnd = buffer.indexOf('\n');
    if (headerEnd !== -1 && buffer.slice(0, 16).toString('utf8').toLowerCase().startsWith('content-length:')) {
      const header = buffer.slice(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      const length = match ? Number(match[1]) : 0;
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const json = buffer.slice(start, start + length).toString('utf8');
      buffer = buffer.slice(start + length);
      try {
        void handle(JSON.parse(json));
      } catch {
        // ignore malformed frames
      }
      continue;
    }
    if (lineEnd !== -1 && buffer[0] === 0x7b) {
      const line = buffer.slice(0, lineEnd).toString('utf8').trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line) continue;
      try {
        void handle(JSON.parse(line));
      } catch {
        // ignore
      }
      continue;
    }
    return;
  }
});

process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
