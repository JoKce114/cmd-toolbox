export type ModuleKind = 'diagnostics';

export type EditorModule = {
  id: string;
  name: string;
  description: string;
  kind: ModuleKind;
  languages: string[];
  // 首版所有模块都内置在安装包里，这个字段为将来的下载制模块预留
  requires?: 'download';
};

// 只有诊断需要开关：压缩在保存时总是自动执行（同名 .min.js 存在才更新），
// 文件树右键也能随时生成，没有「关掉」的意义，所以不列在这里。
export const EDITOR_MODULES: EditorModule[] = [
  {
    id: 'diag-js',
    name: 'JS / JSX 语法检查',
    description: '在编辑器里用波浪线标出语法错误。TS / TSX 暂不支持',
    kind: 'diagnostics',
    languages: ['js', 'mjs', 'cjs', 'jsx'],
  },
  {
    id: 'diag-php',
    name: 'PHP 语法检查',
    description: '基于纯 JS 解析器，不需要安装 PHP',
    kind: 'diagnostics',
    languages: ['php'],
  },
];

export const DEFAULT_ENABLED_MODULES = ['diag-php'];

export function findModule(id: string): EditorModule | undefined {
  return EDITOR_MODULES.find((item) => item.id === id);
}

export function modulesFor(kind: ModuleKind, lang: string): EditorModule[] {
  return EDITOR_MODULES.filter(
    (item) => item.kind === kind && item.languages.includes(lang),
  );
}
