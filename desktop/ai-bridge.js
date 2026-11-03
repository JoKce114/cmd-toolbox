const crypto = require('crypto');

const DEFAULT_TIMEOUT = 15000;

let send = null;
let defaultTimeoutMs = DEFAULT_TIMEOUT;
const pending = new Map();

function configure(options = {}) {
  if (typeof options.send === 'function') send = options.send;
  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    defaultTimeoutMs = Math.min(60000, Math.floor(options.timeoutMs));
  }
}

function request(op, payload = {}, timeoutMs) {
  // 窗口没起来时立即失败，不排队——排队会让 AI 误以为操作被接受了
  if (typeof send !== 'function') {
    const error = new Error('窗口未就绪，无法执行该操作');
    error.code = 'ui-unavailable';
    return Promise.reject(error);
  }
  const requestId = crypto.randomUUID();
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : defaultTimeoutMs;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      const error = new Error('渲染进程没有在超时内响应');
      error.code = 'ui-unavailable';
      reject(error);
    }, limit);
    pending.set(requestId, { resolve, reject, timer });
    try {
      send({ requestId, op, payload });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(error);
    }
  });
}

function settle(requestId, ok, payload) {
  const entry = pending.get(String(requestId || ''));
  if (!entry) return false;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  if (ok) {
    entry.resolve(payload);
  } else {
    const error = new Error((payload && payload.message) || '渲染进程执行失败');
    error.code = (payload && payload.code) || 'ui-unavailable';
    entry.reject(error);
  }
  return true;
}

function pendingCount() {
  return pending.size;
}

module.exports = { configure, request, settle, pendingCount };
