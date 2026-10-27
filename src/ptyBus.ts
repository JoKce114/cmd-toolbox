type DataHandler = (data: string) => void;
type ExitHandler = (sessionId: string, code: number) => void;

const dataHandlers = new Map<string, Set<DataHandler>>();
const pendingData = new Map<string, string>();
const exitHandlers = new Set<ExitHandler>();
const allDataHandlers = new Set<(sessionId: string, data: string) => void>();

let started = false;

const MAX_BUFFER = 512 * 1024;

export function startPtyBus() {
  if (started) return;
  started = true;

  window.api.pty.onData((sessionId, data) => {
    allDataHandlers.forEach((handler) => handler(sessionId, data));
    const handlers = dataHandlers.get(sessionId);
    if (handlers && handlers.size > 0) {
      handlers.forEach((handler) => handler(data));
      return;
    }
    const combined = (pendingData.get(sessionId) || '') + data;
    pendingData.set(
      sessionId,
      combined.length > MAX_BUFFER ? combined.slice(combined.length - MAX_BUFFER) : combined,
    );
  });

  window.api.pty.onExit((sessionId, code) => {
    exitHandlers.forEach((handler) => handler(sessionId, code));
  });
}

export function subscribeAllData(
  handler: (sessionId: string, data: string) => void,
): () => void {
  startPtyBus();
  allDataHandlers.add(handler);
  return () => {
    allDataHandlers.delete(handler);
  };
}

export function subscribeData(sessionId: string, handler: DataHandler): () => void {
  startPtyBus();
  let handlers = dataHandlers.get(sessionId);
  if (!handlers) {
    handlers = new Set();
    dataHandlers.set(sessionId, handlers);
  }
  handlers.add(handler);

  const buffered = pendingData.get(sessionId);
  if (buffered) {
    pendingData.delete(sessionId);
    handler(buffered);
  }

  return () => {
    const current = dataHandlers.get(sessionId);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) dataHandlers.delete(sessionId);
  };
}

export function subscribeExit(handler: ExitHandler): () => void {
  startPtyBus();
  exitHandlers.add(handler);
  return () => {
    exitHandlers.delete(handler);
  };
}

export function discardSession(sessionId: string) {
  dataHandlers.delete(sessionId);
  pendingData.delete(sessionId);
}
