const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { webContents } = require('electron');

const DEFAULT_PORT = 17382;

let server = null;
let token = '';
let port = 0;
let panes = [];
const guests = new Map();
let getTerminalOutput = () => '';

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('请求过大'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function authorized(req, url) {
  const header = String(req.headers.authorization || '');
  const queryToken = url.searchParams.get('token') || '';
  const got = header.startsWith('Bearer ') ? header.slice(7) : queryToken;
  return Boolean(got && got === token);
}

// 页签编号只在项目内递增，多个项目都会有 #1。
// 支持三种写法：
//   <tabId>            精确匹配
//   <项目名>#<编号>     按项目限定，如「B2C 6.0#1」
//   #<编号>            沿用旧行为；若多个项目重号则报错，避免打错目标
function findPane(ref) {
  const raw = String(ref || '').trim();
  if (!raw) return null;

  const byId = panes.find((pane) => pane.id === raw);
  if (byId) return byId;

  const scoped = raw.match(/^(.*)#(\d+)$/);
  if (scoped) {
    const projectName = scoped[1].trim();
    const number = Number(scoped[2]);
    if (projectName) {
      return (
        panes.find(
          (pane) =>
            pane.paneNo === number &&
            String(pane.groupName || '').toLowerCase() === projectName.toLowerCase(),
        ) || null
      );
    }
  }

  const number = Number(raw.replace(/^#/, ''));
  if (!Number.isFinite(number) || number < 1) return null;
  const hits = panes.filter((pane) => pane.paneNo === number);
  if (hits.length > 1) {
    const names = hits.map((pane) => pane.groupName || '未命名项目').join('、');
    const error = new Error(
      `编号 #${number} 在多个项目里都有（${names}）。请改用「项目名#编号」，例如 ${hits[0].groupName}#${number}`,
    );
    error.status = 409;
    throw error;
  }
  return hits[0] || null;
}

function guestOf(pane) {
  if (!pane) return null;
  const id = guests.get(pane.id);
  if (!id) return null;
  try {
    return webContents.fromId(id);
  } catch {
    return null;
  }
}

const SNAPSHOT_SCRIPT = `(() => {
  const nodes = [...document.querySelectorAll('a, button, input, textarea, select, [role="button"]')];
  const seen = new Set();
  const items = [];
  for (const el of nodes) {
    if (items.length >= 80) break;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (rect.bottom < 0 || rect.top > innerHeight) continue;
    const text = String(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
      .trim()
      .replace(/\\s+/g, ' ')
      .slice(0, 80);
    const href = el.href || '';
    const key = text + '|' + href + '|' + el.tagName;
    if (seen.has(key)) continue;
    seen.add(key);
    const index = items.length + 1;
    el.setAttribute('data-cmdtb', String(index));
    items.push({
      index,
      tag: el.tagName.toLowerCase(),
      text,
      href,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    });
  }
  const root = document.body || document.documentElement;
  return {
    text: (root && root.innerText ? root.innerText : '').slice(0, 16000),
    elements: items,
  };
})()`;

async function paneContent(pane) {
  if (pane.kind === 'browser') {
    const guest = guestOf(pane);
    if (!guest || guest.isDestroyed()) {
      return {
        paneNo: pane.paneNo,
        kind: 'browser',
        url: pane.url || '',
        text: '',
        elements: [],
        note: '浏览器还没有就绪',
      };
    }
    const snapshot = await guest.executeJavaScript(SNAPSHOT_SCRIPT, true);
    return {
      paneNo: pane.paneNo,
      kind: 'browser',
      url: pane.url || guest.getURL() || '',
      title: guest.getTitle ? guest.getTitle() : '',
      text: String((snapshot && snapshot.text) || ''),
      elements: (snapshot && snapshot.elements) || [],
      note: '要点击请用 browser_click，传入 index（elements 里的编号），不要下载 HTML 或写 Python。',
    };
  }
  if (pane.kind === 'editor') {
    return {
      paneNo: pane.paneNo,
      kind: 'editor',
      filePath: pane.filePath || '',
      text: '',
      note: '这是编辑器页签，没有终端输出。',
    };
  }
  return {
    paneNo: pane.paneNo,
    kind: 'terminal',
    shellId: pane.shellId,
    text: String(getTerminalOutput(pane.sessionId) || '').slice(-24000),
  };
}

const MCP_TOOLS = [
  {
    name: 'list_panes',
    description:
      '列出 Cmd Toolbox 当前工作台的窗格。页签最前面的 #1 #2 就是这里的编号。用户说「窗口」「#2」时必须用本工具，不要调用 ccpanes。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_pane_content',
    description:
      '读取 Cmd Toolbox 某个窗格。浏览器返回可见文字和可点元素清单（index）。看 #2 必须用本工具，不要用 ccpanes，不要下载 HTML，不要写 Python。',
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
    description:
      '点击 Cmd Toolbox 浏览器里的元素。优先传 index（来自 get_pane_content 的 elements）。也可以传 selector 或坐标 x/y。',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string' },
        index: { type: 'number', description: '可点元素编号，来自 get_pane_content' },
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

async function callMcpTool(name, args) {
  const pane = args && args.pane;
  if (name === 'list_panes') return dispatch('GET', '/panes', {});
  if (name === 'get_pane_content') {
    return dispatch('GET', `/panes/${encodeURIComponent(pane || '')}/content`, {});
  }
  if (name === 'browser_screenshot') {
    return dispatch('GET', `/panes/${encodeURIComponent(pane || '')}/screenshot`, {});
  }
  if (name === 'browser_navigate') {
    return dispatch('POST', `/panes/${encodeURIComponent(pane || '')}/navigate`, { url: args.url });
  }
  if (name === 'browser_click') {
    return dispatch('POST', `/panes/${encodeURIComponent(pane || '')}/click`, {
      x: args.x,
      y: args.y,
      index: args.index,
      selector: args.selector,
    });
  }
  if (name === 'browser_type') {
    return dispatch('POST', `/panes/${encodeURIComponent(pane || '')}/type`, {
      text: args.text,
      selector: args.selector,
    });
  }
  throw new Error(`未知工具：${name}`);
}

async function handleMcpMessage(message) {
  if (!message || message.jsonrpc !== '2.0') return null;
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
    return null;
  }
  if (typeof message.id === 'undefined') return null;
  try {
    if (message.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'cmdtoolbox', version: '1.0.0' },
        },
      };
    }
    if (message.method === 'tools/list') {
      return { jsonrpc: '2.0', id: message.id, result: { tools: MCP_TOOLS } };
    }
    if (message.method === 'ping') {
      return { jsonrpc: '2.0', id: message.id, result: {} };
    }
    if (message.method === 'tools/call') {
      const name = message.params && message.params.name;
      const args = (message.params && message.params.arguments) || {};
      const result = await callMcpTool(name, args);
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        },
      };
    }
    return {
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `未知方法：${message.method}` },
    };
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: error.message || String(error) }],
        isError: true,
      },
    };
  }
}

async function dispatch(method, pathname, body) {
  const parts = pathname.split('/').filter(Boolean);
  if (method === 'GET' && pathname === '/health') {
    return { ok: true };
  }
  if (method === 'GET' && pathname === '/panes') {
    return {
      panes: panes.map((pane) => ({
        paneNo: pane.paneNo,
        ref: `#${pane.paneNo}`,
        scopedRef: pane.groupName ? `${pane.groupName}#${pane.paneNo}` : `#${pane.paneNo}`,
        kind: pane.kind,
        title: pane.descriptor,
        project: pane.groupName,
        url: pane.url || '',
        shellId: pane.shellId,
        exited: Boolean(pane.exited),
      })),
      note: '这些是 Cmd Toolbox 页签。编号只在项目内唯一，跨项目重号时请用 scopedRef（如「B2C 6.0#1」）指定。',
    };
  }
  if (parts[0] !== 'panes' || !parts[1]) {
    const error = new Error('接口不存在');
    error.status = 404;
    throw error;
  }
  const pane = findPane(decodeURIComponent(parts[1]));
  if (!pane) {
    const error = new Error('找不到这个窗格，请先用 list_panes 看编号');
    error.status = 404;
    throw error;
  }
  const action = parts[2] || 'content';
  if (method === 'GET' && action === 'content') {
    return paneContent(pane);
  }
  if (method === 'GET' && action === 'screenshot') {
    if (pane.kind !== 'browser') throw Object.assign(new Error('只有浏览器能截图'), { status: 400 });
    const guest = guestOf(pane);
    if (!guest || guest.isDestroyed()) throw Object.assign(new Error('浏览器还没有就绪'), { status: 409 });
    const image = await guest.capturePage();
    const file = path.join(os.tmpdir(), `cmdtoolbox-#${pane.paneNo}-${Date.now()}.png`);
    fs.writeFileSync(file, image.toPNG());
    return { paneNo: pane.paneNo, path: file };
  }
  if (method === 'POST' && action === 'navigate') {
    if (pane.kind !== 'browser') throw Object.assign(new Error('只有浏览器能跳转'), { status: 400 });
    const url = String(body.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw Object.assign(new Error('只支持 http 或 https'), { status: 400 });
    const guest = guestOf(pane);
    if (!guest || guest.isDestroyed()) throw Object.assign(new Error('浏览器还没有就绪'), { status: 409 });
    await guest.loadURL(url);
    return { ok: true, paneNo: pane.paneNo, url };
  }
  if (method === 'POST' && action === 'click') {
    if (pane.kind !== 'browser') throw Object.assign(new Error('只有浏览器能点击'), { status: 400 });
    const guest = guestOf(pane);
    if (!guest || guest.isDestroyed()) throw Object.assign(new Error('浏览器还没有就绪'), { status: 409 });
    const index = Number(body.index);
    const selector = typeof body.selector === 'string' ? body.selector : '';
    if (Number.isFinite(index) && index >= 1) {
      const clicked = await guest.executeJavaScript(
        `(() => {
          const el = document.querySelector('[data-cmdtb="${Math.floor(index)}"]');
          if (!el) return false;
          el.click();
          return true;
        })()`,
        true,
      );
      if (!clicked) throw Object.assign(new Error('找不到这个编号，请先 get_pane_content'), { status: 404 });
      return { ok: true, paneNo: pane.paneNo, index: Math.floor(index) };
    }
    if (selector) {
      const clicked = await guest.executeJavaScript(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          el.click();
          return true;
        })()`,
        true,
      );
      if (!clicked) throw Object.assign(new Error('找不到这个选择器'), { status: 404 });
      return { ok: true, paneNo: pane.paneNo, selector };
    }
    const x = Math.max(0, Number(body.x) || 0);
    const y = Math.max(0, Number(body.y) || 0);
    guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    return { ok: true, paneNo: pane.paneNo, x, y };
  }
  if (method === 'POST' && action === 'type') {
    if (pane.kind !== 'browser') throw Object.assign(new Error('只有浏览器能输入'), { status: 400 });
    const guest = guestOf(pane);
    if (!guest || guest.isDestroyed()) throw Object.assign(new Error('浏览器还没有就绪'), { status: 409 });
    const text = String(body.text || '');
    const selector = typeof body.selector === 'string' ? body.selector : '';
    if (selector) {
      await guest.executeJavaScript(
        `(() => {
          const node = document.querySelector(${JSON.stringify(selector)});
          if (!node) return false;
          node.focus();
          if ('value' in node) node.value = ${JSON.stringify(text)};
          node.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`,
        true,
      );
    } else {
      for (const character of text) {
        guest.sendInputEvent({ type: 'char', keyCode: character });
      }
    }
    return { ok: true, paneNo: pane.paneNo };
  }
  const error = new Error('接口不存在');
  error.status = 404;
  throw error;
}

function loadToken(dataDir) {
  const file = path.join(dataDir, 'mcp-token.txt');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{32}$/i.test(saved)) return saved;
  } catch {
    // first run
  }
  const next = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
  return next;
}

function start(options) {
  if (typeof options.getTerminalOutput === 'function') {
    getTerminalOutput = options.getTerminalOutput;
  }
  const dataDir = options.dataDir || os.tmpdir();
  token = loadToken(dataDir);
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const isProbe =
        req.method === 'GET' && (url.pathname === '/mcp' || url.pathname === '/sse' || url.pathname === '/health');
      if (!isProbe && !authorized(req, url)) {
        json(res, 401, { error: '未授权' });
        return;
      }
      const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {};
      if (url.pathname === '/mcp' || url.pathname === '/sse') {
        if (req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write(`event: endpoint\ndata: /mcp?token=${token}\n\n`);
          req.on('close', () => res.end());
          return;
        }
        const messages = Array.isArray(body) ? body : [body];
        const replies = [];
        for (const message of messages) {
          const reply = await handleMcpMessage(message);
          if (reply) replies.push(reply);
        }
        if (!replies.length) {
          res.writeHead(202);
          res.end();
          return;
        }
        json(res, 200, replies.length === 1 ? replies[0] : replies);
        return;
      }
      const payload = await dispatch(req.method || 'GET', url.pathname, body);
      json(res, 200, payload);
    } catch (error) {
      json(res, error.status || 500, { error: error.message || String(error) });
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(DEFAULT_PORT, '127.0.0.1', () => {
      port = server.address().port;
      resolve(getInfo());
    });
  });
}

function getInfo() {
  return {
    port,
    token,
    url: `http://127.0.0.1:${port}`,
    mcpUrl: `http://127.0.0.1:${port}/mcp?token=${token}`,
  };
}

function setPanes(next) {
  panes = Array.isArray(next) ? next : [];
}

function attachBrowser(tabId, webContentsId) {
  if (typeof tabId !== 'string' || !tabId) return;
  const id = Number(webContentsId);
  if (!id) return;
  guests.set(tabId, id);
}

function detachBrowser(tabId) {
  if (typeof tabId === 'string') guests.delete(tabId);
}

module.exports = { start, getInfo, setPanes, attachBrowser, detachBrowser };
