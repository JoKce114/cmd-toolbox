import type { Diagnostic } from './registry';

type AcornModule = typeof import('acorn');
type AcornParserCtor = AcornModule['Parser'];
type JsxPluginFactory = (options?: unknown) => (Base: AcornParserCtor) => AcornParserCtor;

// acorn-jsx 是 CommonJS 包（`export = jsx`），导出的是插件工厂函数本身。
// Node 里 require 到的是函数，Vite 的互操作下可能落在 default 上，两种形态都兜。
// 必须用 acorn 自己的 Parser.extend，插件才能挂到同一个 parser 实例上。
async function loadParserWithJsx(): Promise<AcornParserCtor> {
  const [acorn, jsxModule] = await Promise.all([import('acorn'), import('acorn-jsx')]);
  const namespace: unknown = jsxModule;
  const candidate =
    typeof namespace === 'function'
      ? namespace
      : typeof (namespace as { default?: unknown }).default === 'function'
        ? (namespace as { default: unknown }).default
        : (namespace as { default?: { default?: unknown } }).default?.default;
  if (typeof candidate !== 'function') throw new Error('acorn-jsx 导出不可用');
  const factory = candidate as unknown as JsxPluginFactory;
  return acorn.Parser.extend(factory());
}

// 只用于 JS 系（js/mjs/cjs/jsx）。TS/TSX 故意不接：acorn 不认识类型注解，
// 强行解析会把合法代码报成语法错误。
export async function diagnoseJs(text: string, lang: string): Promise<Diagnostic[]> {
  try {
    // .jsx 必须挂 acorn-jsx，否则所有 React 组件都会被报成语法错误
    const parser: AcornParserCtor =
      lang === 'jsx' ? await loadParserWithJsx() : (await import('acorn')).Parser;
    parser.parse(text, {
      ecmaVersion: 'latest',
      // .cjs 按脚本解析，其余按模块；两者都允许 module.exports / import
      sourceType: lang === 'cjs' ? 'script' : 'module',
      locations: true,
      allowHashBang: true,
    });
    return [];
  } catch (error) {
    const err = error as { message?: string; pos?: number };
    const rawFrom = typeof err.pos === 'number' && Number.isFinite(err.pos) ? err.pos : 0;
    const from = Math.max(0, Math.min(text.length, rawFrom));
    return [
      {
        from,
        to: Math.min(text.length, from + 1),
        severity: 'error',
        message: err.message || '语法错误',
      },
    ];
  }
}
