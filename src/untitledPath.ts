// 空白窗口在 useEditorFiles 的 files 里用虚拟路径当键。
// 这个文件是唯一的判断来源：所有碰磁盘或 mtime 的地方都必须先过 isUntitledPath()，
// 不要在调用方各自写 startsWith 判断——漏一处就会拿伪路径去读磁盘。

export const UNTITLED_PREFIX = 'untitled://';

// 前缀之后必须是非零正整数：untitledPathFor() 只会产出这种形式，
// 空的 / 0 / 前导零 / 非数字都不是合法虚拟路径。
export function isUntitledPath(relPath: string): boolean {
  const value = String(relPath || '');
  if (!value.startsWith(UNTITLED_PREFIX)) return false;
  const index = value.slice(UNTITLED_PREFIX.length);
  return /^[1-9]\d*$/.test(index);
}

export function untitledPathFor(index: number): string {
  return `${UNTITLED_PREFIX}${index}`;
}

// 取最小可用编号：关掉 Untitled-1 再新建，拿到的还是 Untitled-1。
// 普通路径不参与计算，避免和真实文件名冲突。
export function nextUntitledIndex(paths: string[]): number {
  const used = new Set<number>();
  for (const relPath of paths) {
    if (!isUntitledPath(relPath)) continue;
    const index = Number(relPath.slice(UNTITLED_PREFIX.length));
    if (Number.isInteger(index) && index > 0) used.add(index);
  }
  let index = 1;
  while (used.has(index)) index += 1;
  return index;
}

// 页签标题与「打开的编辑器」列表都用它，虚拟路径显示成 Untitled-N
export function displayNameFor(relPath: string): string {
  if (!relPath) return '编辑器';
  if (isUntitledPath(relPath)) {
    return `Untitled-${relPath.slice(UNTITLED_PREFIX.length)}`;
  }
  return relPath.split('/').pop() || relPath;
}
