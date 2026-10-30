// JS 压缩模块。
// 自动压缩的判定依据是「同名 .min.js 是否存在」，不是设置里的开关：
// 不存在就绝不创建，存在就每次保存都覆盖（哪怕源文件没改）。
// terser 用动态 import，和格式化插件一样按需加载，不进首屏。

// 只处理最后一段文件名：目录名带点时（dir.v2/README）不能把目录里的点当扩展名。
// 没有扩展名时原样返回——调用方（自动压缩、菜单）都先按 .js 过滤，返回原值不会误压。
export function minifiedName(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  const dir = relPath.slice(0, slash + 1);
  const base = relPath.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return relPath;
  return `${dir}${base.slice(0, dot)}.min${base.slice(dot)}`;
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

// 同一目标串行化，并且「后发起的覆盖先前的」：
// 连按 Ctrl+S 会瞬间排起多个任务，旧内容既不该压在最新内容之后落盘，
// 也不该和最新内容同时写同一个文件（写入会互相截断）。
// 每个目标最多一个任务在跑 + 一个待写任务；待写任务被新任务替换时，
// 旧任务直接 resolve（它的内容已经被更新的一次覆盖，没必要再写盘）。
type MinifyTask = {
  content: string;
  write: (compressed: string) => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

const minifyQueues = new Map<string, { next: MinifyTask | null }>();

function queueKey(projectPath: string, relPath: string): string {
  return `${projectPath}\u0000${relPath}`;
}

async function runMinifyTask(task: MinifyTask): Promise<void> {
  try {
    const compressed = await minify(task.content);
    await task.write(compressed);
    task.resolve();
  } catch (error) {
    task.reject(error);
  }
}

export function enqueueMinify(
  projectPath: string,
  targetPath: string,
  content: string,
  write: (compressed: string) => Promise<void>,
): Promise<void> {
  const key = queueKey(projectPath, targetPath);
  return new Promise((resolve, reject) => {
    const task: MinifyTask = { content, write, resolve, reject };
    const queue = minifyQueues.get(key);
    if (queue) {
      // 已有任务在跑：只保留最后一次的内容
      queue.next?.resolve();
      queue.next = task;
      return;
    }
    minifyQueues.set(key, { next: null });
    void (async () => {
      await runMinifyTask(task);
      const current = minifyQueues.get(key);
      while (current?.next) {
        const next = current.next;
        current.next = null;
        await runMinifyTask(next);
      }
      minifyQueues.delete(key);
    })();
  });
}
