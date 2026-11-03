// 页签工具：建终端 / 建浏览器 / 关页签。
// 这里只负责把参数整理成桥接 op，真正的建页签逻辑在渲染进程（App.tsx 的
// bridge.onRequest）。工具描述要告诉 AI 两件事：project 可省略（用当前激活
// 项目），返回的 scopedRef 可以直接回传给后续工具。
const aiBridge = require('../ai-bridge');

function projectGroupKey(args) {
  const value = args && typeof args.project === 'string' ? args.project.trim() : '';
  return value;
}

// 本地错误与桥接错误用同一种呈现方式：code 写进消息前缀，AI 才能看见。
function toolError(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}

// ai-bridge 的失败 Error 带稳定 code（ui-unavailable / pane-not-found 等），
// 但 MCP 回包目前只取 message，这里统一转成带前缀的 toolError。
async function bridgeRequest(op, payload) {
  try {
    return await aiBridge.request(op, payload);
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : '';
    if (!code) throw error;
    throw toolError(code, (error && error.message) || '操作失败');
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

// 渲染进程只回 groupKey（项目 key），项目名要回到 panes 数组里找。
// 新建页签可能还没同步到 panes（panes:sync 是异步 effect），找不到时退回 #N。
function projectNameOf(ctx, groupKey) {
  if (!groupKey || !ctx || !Array.isArray(ctx.panes)) return '';
  const hit = ctx.panes.find((pane) => pane && pane.groupKey === groupKey && pane.groupName);
  return hit ? String(hit.groupName) : '';
}

// 往回包里补 scopedRef：编号只在项目内唯一，跨项目重号时 #N 会撞 409。
// pane 保持 #N 以兼容旧用法，tabId 由渲染进程回包原样透出。
function withPaneRefs(result, ctx) {
  if (!result || typeof result !== 'object') return result;
  const paneNo = Number(result.paneNo);
  if (!Number.isFinite(paneNo) || paneNo < 1) return result;
  const groupKey = typeof result.groupKey === 'string' ? result.groupKey : '';
  const projectName = projectNameOf(ctx, groupKey);
  return {
    ...result,
    pane: `#${paneNo}`,
    scopedRef: projectName ? `${projectName}#${paneNo}` : `#${paneNo}`,
  };
}

const TOOLS = [
  {
    name: 'open_terminal',
    description:
      '在 Cmd Toolbox 里打开一个新的终端页签（用户可见，带 AI 标记）。返回 pane（如 #3）、scopedRef（如「项目名#3」）与 sessionId；后续工具优先用 scopedRef 回传，跨项目重号时不会歧义。不传 project 时使用当前激活的项目。',
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
      '在 Cmd Toolbox 里打开一个新的浏览器页签（用户可见，带 AI 标记）。返回 pane（如 #3）与 scopedRef（如「项目名#3」）；后续工具优先用 scopedRef 回传，跨项目重号时不会歧义。不传 project 时使用当前激活的项目。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目名或 groupKey，省略则用当前激活项目' },
        url: {
          type: 'string',
          description: '要打开的地址：http/https，或 about:blank；省略时为 about:blank',
        },
      },
    },
  },
  {
    name: 'close_pane',
    description:
      '关闭 Cmd Toolbox 里的某个页签。pane 支持页签编号（#3）、项目名#编号或 tabId，可直接用 open_terminal / open_browser 返回的 scopedRef。',
    inputSchema: {
      type: 'object',
      properties: { pane: { type: 'string', description: '页签编号，如 #3' } },
      required: ['pane'],
    },
  },
];

// 空、about:blank、http/https 都放行；大小写与前后空格先归一。
function isAllowedUrl(url) {
  const trimmed = url.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (lower === 'about:blank') return true;
  return /^https?:\/\//i.test(trimmed);
}

async function call(name, args, ctx) {
  const input = args && typeof args === 'object' ? args : {};
  if (name === 'open_terminal') {
    const groupKey = projectGroupKey(input);
    const result = await bridgeRequest('create-terminal', {
      groupKey,
      shellId: typeof input.shellId === 'string' ? input.shellId : '',
    });
    return withPaneRefs(result, ctx);
  }
  if (name === 'open_browser') {
    const groupKey = projectGroupKey(input);
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (!isAllowedUrl(url)) {
      throw toolError('bad-request', '只支持 http/https 地址或 about:blank');
    }
    const result = await bridgeRequest('create-browser', { groupKey, url });
    return withPaneRefs(result, ctx);
  }
  if (name === 'close_pane') {
    const pane = resolvePane(ctx, input.pane);
    return bridgeRequest('close-pane', { groupKey: pane.groupKey, tabId: pane.id });
  }
  throw toolError('bad-request', `未知工具：${name}`);
}

module.exports = { TOOLS, call };
