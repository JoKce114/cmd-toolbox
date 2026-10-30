import type { Diagnostic } from './registry';

type PhpError = {
  message?: string;
  line?: number;
  loc?: { start?: { offset?: number; line?: number } };
};

type PhpAst = { errors?: PhpError[] };

type PhpEngine = { parseCode(code: string, filename: string): PhpAst };

type PhpEngineCtor = new (options: unknown) => PhpEngine;

// php-parser 的打包产物会读 Node 的 process（判断自己跑在哪、读 env）。
// 浏览器环境没有这个全局，直接访问会抛 ReferenceError 把整个渲染进程带崩。
// 补一个最小 shim：只提供它真正会碰到的字段，用不着完整 polyfill。
// 放在这里而不是 vite define，是因为 define 会全局文本替换所有依赖里的
// process.*，可能影响 xterm 之类按平台分支的库。
function ensureProcessShim() {
  const scope = globalThis as { process?: Record<string, unknown> };
  if (scope.process) return;
  scope.process = {
    env: { NODE_ENV: 'production' },
    platform: 'browser',
    arch: 'x64',
    versions: { node: '' },
  };
}

// php-parser 是 CommonJS 包。Node 里 require 到的对象同时带 Engine、parser、
// default（default === Engine）；Vite 的 CJS 互操作会让 default 变成 module.exports
// 本体。两种形态都兜住，避免取不到构造函数。
async function loadEngine(): Promise<PhpEngineCtor> {
  ensureProcessShim();
  const mod = (await import('php-parser')) as unknown as {
    Engine?: PhpEngineCtor;
    default?: PhpEngineCtor | { Engine?: PhpEngineCtor };
  };
  const fallback = mod.default;
  const Engine =
    mod.Engine ?? (typeof fallback === 'function' ? fallback : fallback?.Engine);
  if (!Engine) throw new Error('php-parser 缺少 Engine 导出');
  return Engine;
}

export async function diagnosePhp(text: string): Promise<Diagnostic[]> {
  const Engine = await loadEngine();
  // suppressErrors 打开后解析器不抛异常，语法错误收集在 ast.errors 里。
  const engine = new Engine({
    parser: { extractDoc: false, suppressErrors: true },
    ast: { withPositions: true },
  });

  try {
    const ast = engine.parseCode(text, 'input.php');
    const errors = Array.isArray(ast?.errors) ? ast.errors : [];
    const seen = new Set<string>();
    const diagnostics: Diagnostic[] = [];
    for (const error of errors) {
      const offset = resolveOffset(text, error);
      const from = Math.max(0, Math.min(text.length, offset));
      const to = Math.min(text.length, from + 1);
      // 同一位置常会连报多条，保留第一条即可，避免波浪线重叠
      const key = `${from}:${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push({
        from,
        to,
        severity: 'error',
        message: error?.message || 'PHP 语法错误',
      });
    }
    return diagnostics;
  } catch (error) {
    // 解析器本身抛错（例如编码异常）时仍给出兜底诊断
    const err = error as { message?: string; lineNumber?: number };
    const line = Math.max(1, Number(err.lineNumber) || 1);
    const offset = offsetOfLine(text, line);
    const from = Math.min(text.length, offset);
    return [
      {
        from,
        to: Math.min(text.length, from + 1),
        severity: 'error',
        message: err.message || 'PHP 语法错误',
      },
    ];
  }
}

function resolveOffset(text: string, error: PhpError): number {
  const offset = error?.loc?.start?.offset;
  if (typeof offset === 'number' && Number.isFinite(offset)) return offset;
  const line = Math.max(1, Number(error?.loc?.start?.line ?? error?.line) || 1);
  return offsetOfLine(text, line);
}

function offsetOfLine(text: string, line: number): number {
  let offset = 0;
  for (let index = 1; index < line; index += 1) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return offset;
}
