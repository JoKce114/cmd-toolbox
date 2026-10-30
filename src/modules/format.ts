import type { Plugin } from 'prettier';

// prettier 的 standalone 版本不带任何语言，插件必须显式引入并传进 options.plugins。
// 用动态 import 是为了让每个语言插件各自成 chunk，不打进首屏。

type ParserSpec = {
  parser: string;
  load: () => Promise<Plugin[]>;
};

export async function format(text: string, lang: string): Promise<string> {
  const spec = parserFor(lang);
  if (!spec) throw new Error(`不支持格式化该语言：${lang}`);
  const [{ format: prettierFormat }, plugins] = await Promise.all([
    import('prettier/standalone'),
    spec.load(),
  ]);
  return prettierFormat(text, { parser: spec.parser, plugins, printWidth: 100 });
}

function parserFor(lang: string): ParserSpec | null {
  if (lang === 'json') return { parser: 'json', load: loadBabel };
  if (['js', 'mjs', 'cjs', 'jsx'].includes(lang)) return { parser: 'babel', load: loadBabel };
  if (['ts', 'tsx'].includes(lang)) return { parser: 'typescript', load: loadTypeScript };
  if (lang === 'html' || lang === 'htm') return { parser: 'html', load: loadHtml };
  if (lang === 'css') return { parser: 'css', load: loadCss };
  if (lang === 'md' || lang === 'markdown') return { parser: 'markdown', load: loadMarkdown };
  return null;
}

// babel / typescript 的 AST 打印需要 estree 插件，两个必须一起传。
async function loadBabel(): Promise<Plugin[]> {
  const [babel, estree] = await Promise.all([
    import('prettier/plugins/babel'),
    import('prettier/plugins/estree'),
  ]);
  return [babel, estree];
}

async function loadTypeScript(): Promise<Plugin[]> {
  const [typescript, estree] = await Promise.all([
    import('prettier/plugins/typescript'),
    import('prettier/plugins/estree'),
  ]);
  return [typescript, estree];
}

async function loadHtml(): Promise<Plugin[]> {
  return [await import('prettier/plugins/html')];
}

async function loadCss(): Promise<Plugin[]> {
  return [await import('prettier/plugins/postcss')];
}

async function loadMarkdown(): Promise<Plugin[]> {
  return [await import('prettier/plugins/markdown')];
}
