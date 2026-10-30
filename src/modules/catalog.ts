export type ModuleKind = 'format' | 'minify' | 'diagnostics';

export type EditorModule = {
  id: string;
  name: string;
  description: string;
  kind: ModuleKind;
  languages: string[];
  // 首版所有模块都内置在安装包里，这个字段为将来的下载制模块预留
  requires?: 'download';
};

export const EDITOR_MODULES: EditorModule[] = [
  {
    id: 'format',
    name: '代码格式化',
    description: '支持 JS / TS / HTML / CSS / JSON / Markdown',
    kind: 'format',
    languages: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'html', 'htm', 'css', 'md', 'markdown'],
  },
  {
    id: 'minify',
    name: '代码压缩',
    description: '支持 JS；已有同名 .min.js 时保存自动更新',
    kind: 'minify',
    languages: ['js'],
  },
  {
    id: 'diag-js',
    name: 'JS / TS 语法检查',
    description: '在编辑器里用波浪线标出语法错误',
    kind: 'diagnostics',
    languages: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'],
  },
  {
    id: 'diag-php',
    name: 'PHP 语法检查',
    description: '基于纯 JS 解析器，不需要安装 PHP',
    kind: 'diagnostics',
    languages: ['php'],
  },
];

export const DEFAULT_ENABLED_MODULES = ['format', 'minify', 'diag-php'];

export function findModule(id: string): EditorModule | undefined {
  return EDITOR_MODULES.find((item) => item.id === id);
}

export function modulesFor(kind: ModuleKind, lang: string): EditorModule[] {
  return EDITOR_MODULES.filter(
    (item) => item.kind === kind && item.languages.includes(lang),
  );
}
