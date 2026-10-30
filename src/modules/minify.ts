// JS 压缩模块。
// 自动压缩的判定依据是「同名 .min.js 是否存在」，不是设置里的开关：
// 不存在就绝不创建，存在就每次保存都覆盖（哪怕源文件没改）。
// terser 用动态 import，和格式化插件一样按需加载，不进首屏。

export function minifiedName(relPath: string): string {
  const dot = relPath.lastIndexOf('.');
  if (dot < 0) return `${relPath}.min.js`;
  return `${relPath.slice(0, dot)}.min${relPath.slice(dot)}`;
}

// .min.js 自己不再压缩；目前只有 .js 接入 terser。
export function isMinifiable(relPath: string): boolean {
  return relPath.endsWith('.js') && !relPath.endsWith('.min.js');
}

// lang 预留给将来按语言分派，目前只支持 JS。
export async function minify(text: string, _lang = 'js'): Promise<string> {
  const { minify: terserMinify } = await import('terser');
  // terser 解析失败会直接 reject，不返回 error 字段
  const result = await terserMinify(text, { compress: true, mangle: true });
  if (typeof result.code !== 'string') throw new Error('压缩没有返回内容');
  return result.code;
}

// 只有同名 .min.js 已存在时才自动压缩。stat 对「不存在」返回 exists:false，不抛错。
export async function shouldAutoMinify(
  projectPath: string,
  relPath: string,
): Promise<boolean> {
  if (!isMinifiable(relPath)) return false;
  const info = await window.api.files.stat(projectPath, minifiedName(relPath));
  return info.exists;
}
