import type { Diagnostic } from './registry';

// 只用于 JS 系（js/mjs/cjs/jsx）。TS/TSX 故意不接：acorn 不认识类型注解，
// 强行解析会把合法代码报成语法错误。
export async function diagnoseJs(text: string, lang: string): Promise<Diagnostic[]> {
  const { parse } = await import('acorn');
  try {
    parse(text, {
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
