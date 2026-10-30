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

// 配置与 VS Code 的 Nu-Minify 扩展保持一致（terser 5 下实测逐字节复现了它生成的
// .min.js）。差异点都是有意的：
//   hoist_funs: true     函数声明提前，输出顺序和存量文件一致
//   max_line_len: 32000  超长自动折行，不会整个文件压成一行
//   collapse_vars / reduce_vars: false  这两个 terser 默认开，但开了会让输出与
//                        存量文件不一致，交叉压缩时产生大 diff
// 顶层名不缩写：terser 的 toplevel 默认 false，且本项目里 global_obj 等被
// 数百个 PHP 模板和其他脚本引用，改名会让它们全部 ReferenceError。
const MINIFY_OPTIONS = {
  mangle: true,
  compress: {
    sequences: true,
    properties: true,
    dead_code: true,
    drop_debugger: true,
    unsafe: false,
    unsafe_comps: false,
    conditionals: true,
    comparisons: true,
    evaluate: true,
    booleans: true,
    loops: true,
    unused: true,
    hoist_funs: true,
    keep_fargs: true,
    keep_fnames: false,
    hoist_vars: false,
    if_return: true,
    join_vars: true,
    collapse_vars: false,
    reduce_vars: false,
    side_effects: true,
    pure_getters: false,
    // Nu-Minify 的配置里写的是 pure_funcs: null，terser 的类型只接受数组，
    // 省略即等价（都是「没有纯函数」）
    negate_iife: false,
    drop_console: false,
    passes: 1,
    global_defs: {},
  },
  output: {
    ascii_only: false,
    inline_script: false,
    max_line_len: 32000,
    braces: false,
    semicolons: true,
    comments: false,
    shebang: true,
    // Nu-Minify 的配置里 preamble 也是 null，同理省略
    // quote_style 在 terser 5 里是数字枚举：0 = PreferDouble（自动选更短的那种引号），
    // 对应 Nu-Minify 配置里的 "best"
    quote_style: 0,
  },
};

// lang 预留给将来按语言分派，目前只支持 JS。
export async function minify(text: string, _lang = 'js'): Promise<string> {
  const { minify: terserMinify } = await import('terser');
  // terser 解析失败会直接 reject，不返回 error 字段
  const result = await terserMinify(text, MINIFY_OPTIONS);
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
