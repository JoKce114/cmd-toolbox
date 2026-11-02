export type ModuleKind = 'diagnostics' | 'reference';

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
  {
    id: 'ref-php',
    name: 'PHP 跳转与简介',
    description: '按住 Ctrl 点击函数或类名，查看说明并跳到定义',
    kind: 'reference',
    languages: ['php'],
  },
  {
    id: 'ref-js',
    name: 'JS 跳转与简介',
    description: '按住 Ctrl 点击函数或类名，查看说明并跳到定义。TS / TSX 暂不支持',
    kind: 'reference',
    languages: ['js', 'mjs', 'cjs', 'jsx'],
  },
];

export const DEFAULT_ENABLED_MODULES = ['diag-php', 'ref-php', 'ref-js'];

// seenDefaultModules 字段引入之前发布过的默认模块。
// 老用户的偏好里没有「已见过哪些默认模块」的记录，列表里缺少这些 id
// 只可能是用户自己关掉的，升级时不能自动补回来。
export const LEGACY_DEFAULT_ENABLED_MODULES = ['diag-php'];

// 把新增的默认模块合并进已启用列表：只加不减，已记入 seenDefaults 的模块
// 即使不在 enabled 里也不再补回（那是用户手动关掉的）。
export function mergeDefaultModules(
  enabled: string[],
  seenDefaults: string[],
): { enabledModules: string[]; seenDefaultModules: string[] } {
  const seen = new Set(seenDefaults.filter((id) => Boolean(findModule(id))));
  const enabledModules = enabled.filter((id) => Boolean(findModule(id)));
  for (const id of DEFAULT_ENABLED_MODULES) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!enabledModules.includes(id)) enabledModules.push(id);
  }
  return { enabledModules, seenDefaultModules: [...seen] };
}

export function findModule(id: string): EditorModule | undefined {
  return EDITOR_MODULES.find((item) => item.id === id);
}

export function modulesFor(kind: ModuleKind, lang: string): EditorModule[] {
  return EDITOR_MODULES.filter(
    (item) => item.kind === kind && item.languages.includes(lang),
  );
}
