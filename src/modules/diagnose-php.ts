import type { Diagnostic } from './registry';

type PhpError = {
  message?: string;
  line?: number;
  loc?: { start?: { offset?: number; line?: number } };
};

type PhpAst = { errors?: PhpError[] };

type PhpEngine = { parseCode(code: string, filename: string): PhpAst };

type PhpEngineCtor = new (options: unknown) => PhpEngine;

type PhpProcess = { arch?: string };

// php-parser 的 src/lexer/numbers.js 在模块加载时读 process.arch。
// 渲染进程没有 Node 的 process 全局，直接访问会抛 ReferenceError 把整个
// 渲染进程带崩（表现为 PHP 诊断永远没有标记）。只补它真正需要的 arch ——
// 多给 env/platform 会让后续依赖误判自己跑在 Node 里。
// 用运行时临时挂载而不是 vite define：define 会全局替换所有依赖的 process.*，
// 可能影响 xterm 之类按平台分支的库。
function installProcessShim(): { installed: boolean; previous?: PhpProcess } {
  const scope = globalThis as { process?: PhpProcess };
  // 已经有 arch 说明环境自带可用的 process，不要覆盖。
  // 只有缺 arch 时才补，否则 php-parser 会静默走错误分支。
  if (scope.process?.arch) return { installed: false };
  const previous = scope.process;
  scope.process = { ...(previous || {}), arch: 'x64' };
  return { installed: true, previous };
}

function uninstallProcessShim(state: { installed: boolean; previous?: PhpProcess }) {
  if (!state.installed) return;
  const scope = globalThis as { process?: PhpProcess };
  if (state.previous) {
    scope.process = state.previous;
  } else {
    delete scope.process;
  }
}

// php-parser 是 CommonJS 包。Node 里 require 到的对象同时带 Engine、parser、
// default（default === Engine）；Vite 的 CJS 互操作会让 default 变成 module.exports
// 本体。两种形态都兜住，避免取不到构造函数。
async function loadEngine(): Promise<PhpEngineCtor> {
  const shim = installProcessShim();
  try {
    // Vite 会把 CJS 的 require 提升到 chunk 初始化阶段，import 完成时
    // php-parser 已经读过 process.arch，可以立刻还原，别把全局污染留着。
    const mod = (await import('php-parser')) as unknown as {
      Engine?: PhpEngineCtor;
      default?: PhpEngineCtor | { Engine?: PhpEngineCtor };
    };
    const fallback = mod.default;
    const Engine =
      mod.Engine ?? (typeof fallback === 'function' ? fallback : fallback?.Engine);
    if (!Engine) throw new Error('php-parser 缺少 Engine 导出');
    return Engine;
  } finally {
    uninstallProcessShim(shim);
  }
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
