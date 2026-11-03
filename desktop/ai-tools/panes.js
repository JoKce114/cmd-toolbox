// 页签工具：建终端 / 建浏览器 / 关页签。
// 这里只负责把参数整理成桥接 op，真正的建页签逻辑在渲染进程（App.tsx 的
// bridge.onRequest）。工具描述要告诉 AI 两件事：project 可省略（用当前激活
// 项目），返回的 pane 可以直接回传给后续工具。
const aiBridge = require('../ai-bridge');

function projectGroupKey(args) {
  const value = args && typeof args.project === 'string' ? args.project.trim() : '';
  return value;
}

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ai-bridge 的失败 Error 带稳定 code（ui-unavailable / pane-not-found 等），
// 但 MCP 回包目前只取 message。把 code 拼进消息，AI 才能看到失败原因。
async function bridgeRequest(op, payload) {
  try {
    return await aiBridge.request(op, payload);
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : '';
    const detail = error && error.message ? error.message : '操作失败';
    if (!code) throw error;
    const wrapped = new Error(`[${code}] ${detail}`);
    wrapped.code = code;
    throw wrapped;
  }
}

// findPane 只在「同一编号出现在多个项目」时抛 status=409。原消息已经写明了
// 该怎么改写引用，但 status 字段对 AI 不可见，这里转成 bad-request 并保留原文。
function resolvePane(ctx, ref) {
  let pane;
  try {
    pane = ctx.findPane(ref);
  } catch (error) {
    if (error && error.status === 409) {
      throw toolError('bad-request', error.message);
    }
    throw error;
  }
  if (!pane) {
    throw toolError('pane-not-found', '找不到这个窗格，请先用 list_panes 看编号');
  }
  return pane;
}

const TOOLS = [
  {
    name: 'open_terminal',
    description:
      '在 Cmd Toolbox 里打开一个新的终端页签（用户可见，带 AI 标记）。返回 pane（如 #3）与 sessionId，把返回的 pane 直接传给后续工具即可（get_pane_content / close_pane 等）。不传 project 时使用当前激活的项目。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目名或 groupKey，省略则用当前激活项目' },
        shellId: {
          type: 'string',
          description: '终端类型：cmd / powershell / gitbash / claude 等，省略用项目默认',
        },
      },
    },
  },
  {
    name: 'open_browser',
    description:
      '在 Cmd Toolbox 里打开一个新的浏览器页签（用户可见，带 AI 标记）。返回 pane，可直接传给 get_pane_content / browser_click / close_pane。不传 project 时使用当前激活的项目。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目名或 groupKey，省略则用当前激活项目' },
        url: { type: 'string', description: '要打开的地址，必须是 http/https，省略为 about:blank' },
      },
    },
  },
  {
    name: 'close_pane',
    description:
      '关闭 Cmd Toolbox 里的某个页签。pane 支持页签编号（#3）、项目名#编号或 tabId，可直接用 open_terminal / open_browser 返回的 pane。',
    inputSchema: {
      type: 'object',
      properties: { pane: { type: 'string', description: '页签编号，如 #3' } },
      required: ['pane'],
    },
  },
];

async function call(name, args, ctx) {
  const input = args && typeof args === 'object' ? args : {};
  if (name === 'open_terminal') {
    const groupKey = projectGroupKey(input);
    return bridgeRequest('create-terminal', {
      groupKey,
      shellId: typeof input.shellId === 'string' ? input.shellId : '',
    });
  }
  if (name === 'open_browser') {
    const groupKey = projectGroupKey(input);
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (url && !/^https?:\/\//i.test(url)) {
      throw toolError('bad-request', '只支持 http 或 https 地址');
    }
    return bridgeRequest('create-browser', { groupKey, url });
  }
  if (name === 'close_pane') {
    const pane = resolvePane(ctx, input.pane);
    return bridgeRequest('close-pane', { groupKey: pane.groupKey, tabId: pane.id });
  }
  throw toolError('bad-request', `未知工具：${name}`);
}

module.exports = { TOOLS, call };
