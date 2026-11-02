import { useCallback, useEffect, useRef, useState } from 'react';
import { toErrorMessage } from './lib';
import { enqueueMinify, minifiedName, nextMinifySeq, shouldAutoMinify } from './modules/minify';
import type { Group, OpenedFile } from './types';

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export type EditorFileState = {
  relPath: string;
  content: string;
  savedContent: string;
  encoding: string;
  crlf: boolean;
  mtime: number;
  readOnly: boolean;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  failedPath: string;
};

const EMPTY: EditorFileState = {
  relPath: '',
  content: '',
  savedContent: '',
  encoding: 'utf8',
  crlf: false,
  mtime: 0,
  readOnly: false,
  loading: false,
  saving: false,
  dirty: false,
  failedPath: '',
};

// 多文件编辑：state 以 relPath 为键保存每个文件的内容，activePath 指向当前显示的那个。
// 「没改动也按了 Ctrl+S」和「保存失败」都不是写盘成功，
// 但用户需要能区分：前者该提示「没有修改」，后者该报错。
export type SaveOutcome = 'saved' | 'unchanged' | 'failed';

// 重命名的返回结果。目标页签已存在且源页签有未保存修改时，源页签会原样保留
// （旧路径的页签虽然指向已不存在的文件，但用户内容不能丢），此时 synced 为 false，
// 调用方需要提示用户手动处理。
export type RenameOutcome = { synced: boolean };

export function useEditorFiles(group: Group, onError: (message: string) => void) {
  const [files, setFiles] = useState<Record<string, EditorFileState>>({});
  const [activePath, setActivePath] = useState('');
  const groupRef = useRef(group);
  const filesRef = useRef(files);
  const activePathRef = useRef(activePath);
  // 改过或保存过就永久占住自己的内页签，只有没碰过的才允许被新文件顶替
  const touchedRef = useRef<Set<string>>(new Set());
  // 本应用内写过哪些文件：仅用于区分「多页签互相覆盖」和「外部程序改过」
  const savedByAppRef = useRef<Set<string>>(new Set());
  groupRef.current = group;
  filesRef.current = files;
  activePathRef.current = activePath;

  const patch = useCallback((relPath: string, next: Partial<EditorFileState>) => {
    setFiles((previous) => {
      const current = previous[relPath];
      if (!current) return previous;
      return { ...previous, [relPath]: { ...current, ...next } };
    });
  }, []);

  const open = useCallback(
    async (relPath: string): Promise<boolean> => {
      if (!relPath) return false;

      // 已经打开过就直接切过去，保留未保存的修改
      if (filesRef.current[relPath]) {
        setActivePath(relPath);
        return true;
      }

      // 顶替一个没被动过的内页签：当前激活的优先，其次最近打开的。
      // 这样「看一眼就换文件」不会把页签栏撑满，改过的文件则各自占住位置。
      const replaceable = (path: string) => {
        const entry = filesRef.current[path];
        return Boolean(entry) && !entry.dirty && !touchedRef.current.has(path);
      };
      const current = activePathRef.current;
      let target = current && replaceable(current) ? current : '';
      if (!target) {
        const candidates = Object.keys(filesRef.current).filter(replaceable);
        target = candidates[candidates.length - 1] || '';
      }

      setActivePath(relPath);
      setFiles((previous) => {
        const next = { ...previous };
        if (target) delete next[target];
        next[relPath] = { ...EMPTY, relPath, loading: true };
        return next;
      });

      try {
        const result: OpenedFile = await window.api.files.read(groupRef.current.path, relPath);
        setFiles((previous) => {
          // 加载期间用户可能已经关掉了这个标签
          if (!previous[relPath]) return previous;
          return {
            ...previous,
            [relPath]: {
              relPath,
              content: result.content,
              savedContent: result.content,
              encoding: result.encoding,
              crlf: result.content.includes('\r\n'),
              mtime: result.mtime,
              readOnly: result.readOnly,
              loading: false,
              saving: false,
              dirty: false,
              failedPath: '',
            },
          };
        });
        return true;
      } catch (error) {
        onError(toErrorMessage(error));
        setFiles((previous) => {
          const next = { ...previous };
          delete next[relPath];
          return next;
        });
        setActivePath((current) => (current === relPath ? '' : current));
        return false;
      }
    },
    [onError],
  );

  const update = useCallback(
    (relPath: string, content: string) => {
      setFiles((previous) => {
        const current = previous[relPath];
        if (!current) return previous;
        const dirty = normalizeNewlines(content) !== normalizeNewlines(current.savedContent);
        // 内容一变就占住页签：dirty 会在保存后复位，这里不能再跟着放开
        if (dirty) touchedRef.current.add(relPath);
        return {
          ...previous,
          [relPath]: {
            ...current,
            content,
            // CodeMirror 会把 \r\n 规范化成 \n，磁盘内容仍是 \r\n；
            // 直接比较会让 CRLF 文件一打开就是「已修改」状态。
            dirty,
          },
        };
      });
    },
    [],
  );

  // 从磁盘重新载入一个已打开的文件。有未保存修改时直接跳过——
  // 那时用户手上有更新的内容，静默替换等于丢数据。
  // 返回值没人用：React 不保证 updater 同步执行，`replaced` 这类副作用不可靠。
  const reloadFromDisk = useCallback(async (relPath: string): Promise<void> => {
    const state = filesRef.current[relPath];
    if (!state || state.dirty || state.saving || state.loading) return;
    try {
      const disk = await window.api.files.read(groupRef.current.path, relPath);
      setFiles((previous) => {
        const target = previous[relPath];
        // await 期间用户可能开始编辑，再确认一次
        if (!target || target.dirty || target.saving) return previous;
        if (normalizeNewlines(target.content) === normalizeNewlines(disk.content)) {
          // 内容一致但 mtime 可能对不上（本应用刚写过），顺手同步
          if (target.mtime === disk.mtime) return previous;
          return { ...previous, [relPath]: { ...target, mtime: disk.mtime } };
        }
        return {
          ...previous,
          [relPath]: {
            ...target,
            content: disk.content,
            savedContent: disk.content,
            crlf: disk.content.includes('\r\n'),
            mtime: disk.mtime,
            dirty: false,
          },
        };
      });
    } catch {
      // 文件被删或暂时读不了：忽略，下一轮再试
    }
  }, []);

  // 自动压缩：判定依据是「同名 .min.js 是否存在」，不是设置开关——不存在就绝不创建。
  // 压缩失败只提示，不 throw，保存流程继续。
  // 同一目标由 enqueueMinify 串行化并只写最后一次的内容，连按 Ctrl+S 不会写坏产物。
  // seq 在发起保存时取好，晚发起的任务序号更大；被取代的任务返回 superseded，
  // 不能让它们去 reload——那时真正的新写入可能还没落盘。
  const autoMinify = useCallback(
    (relPath: string, content: string, seq: number) => {
      void (async () => {
        try {
          const projectPath = groupRef.current.path;
          if (!(await shouldAutoMinify(projectPath, relPath))) return;
          const target = minifiedName(relPath);
          const outcome = await enqueueMinify(
            projectPath,
            target,
            content,
            async (compressed) => {
              await window.api.files.writeMinified(projectPath, target, compressed);
            },
            seq,
          );
          if (outcome !== 'written') return;
          // 产物刚被改写。轮询只盯激活页签，而此刻激活的是源文件，
          // 所以必须在这里主动把开着的 .min.js 页签刷成最新内容。
          // 静默更新，不弹提示——和 VS Code 的外部改动行为一致。
          if (filesRef.current[target]) {
            await reloadFromDisk(target);
          }
        } catch (error) {
          onError(`压缩为 ${minifiedName(relPath)} 失败：${toErrorMessage(error)}`);
        }
      })();
    },
    [onError, reloadFromDisk],
  );

  // 内容没改也保存（干净页签）时，先确认磁盘上的源文件还是我们手里这一版。
  // 外部工具（git checkout 等）刚改过、2 秒轮询还没轮到的情况下，
  // 直接压缩会把旧内容盖到新源文件对应的产物上。这种情况静默跳过：
  // 等轮询把编辑器重载成新内容，用户再保存时才会压出正确结果。
  const autoMinifyIfUnchangedOnDisk = useCallback(
    async (relPath: string, state: EditorFileState, seq: number) => {
      try {
        const info = await window.api.files.stat(groupRef.current.path, relPath);
        if (!info.exists || Math.abs(info.mtime - state.mtime) > 1) return;
        autoMinify(relPath, state.content, seq);
      } catch {
        // 判定失败就当作磁盘已变，宁可不压也不覆盖新产物
      }
    },
    [autoMinify],
  );

  const save = useCallback(
    async (relPath: string): Promise<SaveOutcome> => {
      const current = filesRef.current[relPath];
      if (!current || current.loading || current.readOnly) return 'failed';

      // 主动按 Ctrl+S 等于声明「这个文件我要留着」，哪怕内容没改过，
      // 也不该在打开别的文件时被顶替。
      touchedRef.current.add(relPath);

      // 序号在这里取：任何 await 之前，反映用户真实的保存先后。
      const minifySeq = nextMinifySeq();

      // 自动压缩必须在「内容没变就返回」之前决定：用户要求不管有没有修改都执行。
      // 内容没改时磁盘已经是这份内容，可以立即压缩；
      // 有改动时要等 files.write 成功再压，否则源文件没落地、.min.js 却已是未保存的内容。
      if (!current.dirty) {
        void autoMinifyIfUnchangedOnDisk(relPath, current, minifySeq);
        return 'unchanged';
      }

      const written = current.content;
      // CodeMirror 输出 LF；原文件是 CRLF 时写回要保持原样，否则整个文件的行尾会被改写
      const payload = current.crlf ? written.replace(/\n/g, '\r\n') : written;
      patch(relPath, { saving: true });
      try {
        try {
          await window.api.files.write(
            groupRef.current.path,
            relPath,
            payload,
            current.encoding,
            current.mtime,
          );
        } catch (error) {
          // 同一个文件在多个编辑器页签里打开时，另一处保存过会让这里的 mtime 过期。
          // 只有「本应用刚刚写过这个文件」才用新 mtime 重试；
          // 真正的外部修改仍然报错，避免悄悄覆盖掉别人的改动。
          if (!/外部修改/.test(toErrorMessage(error))) throw error;
          if (!savedByAppRef.current.has(relPath)) throw error;
          const fresh = await window.api.files.read(groupRef.current.path, relPath);
          await window.api.files.write(
            groupRef.current.path,
            relPath,
            payload,
            current.encoding,
            fresh.mtime,
          );
        }
        savedByAppRef.current.add(relPath);
        // 手动保存过的文件同样占住页签，不再被新文件顶替
        touchedRef.current.add(relPath);
        const after = await window.api.files.read(groupRef.current.path, relPath);
        setFiles((previous) => {
          const target = previous[relPath];
          if (!target) return previous;
          return {
            ...previous,
            [relPath]: {
              ...target,
              savedContent: written,
              dirty: normalizeNewlines(target.content) !== normalizeNewlines(written),
              saving: false,
              mtime: after.mtime,
            },
          };
        });
        // 源文件已经落地，这时压缩产物的内容才和磁盘一致
        autoMinify(relPath, written, minifySeq);
        return 'saved';
      } catch (error) {
        onError(toErrorMessage(error));
        patch(relPath, { saving: false });
        return 'failed';
      }
    },
    [autoMinify, autoMinifyIfUnchangedOnDisk, onError, patch],
  );

  // 一次关掉多个页签（删除目录时目录内的页签要一起关）。
  // 必须批量处理：逐个 close() 时 setActivePath 的兜底读的是尚未更新的
  // filesRef，可能把激活页签落到另一个同样已被删掉的路径上。
  const closeMany = useCallback((relPaths: string[]) => {
    const doomed = new Set(relPaths);
    if (doomed.size === 0) return;
    doomed.forEach((relPath) => touchedRef.current.delete(relPath));
    setFiles((previous) => {
      const next = { ...previous };
      doomed.forEach((relPath) => {
        delete next[relPath];
      });
      return next;
    });
    setActivePath((current) => {
      if (!doomed.has(current)) return current;
      const remaining = Object.keys(filesRef.current).filter((item) => !doomed.has(item));
      return remaining[remaining.length - 1] || '';
    });
  }, []);

  const close = useCallback(
    (relPath: string) => {
      closeMany([relPath]);
    },
    [closeMany],
  );

  const closeAll = useCallback(() => {
    setFiles({});
    setActivePath('');
  }, []);

  const rename = useCallback((from: string, to: string): RenameOutcome => {
    if (from === to) return { synced: true };
    const source = filesRef.current[from];
    const targetExists = Boolean(filesRef.current[to]);
    // 目标页签已存在且源页签有未保存修改：既不能覆盖目标页签
    // （它展示的是目标位置的真实内容），也不能删源页签（会丢用户没保存的修改）。
    // 宁可留下一个指向旧路径的页签，让调用方提示用户手动处理。
    if (targetExists && source?.dirty) {
      return { synced: false };
    }
    // 目标已存在时不接收来源页签的「占位」标记，目标页签保持自己的状态。
    if (touchedRef.current.delete(from) && !targetExists) touchedRef.current.add(to);
    setFiles((previous) => {
      if (!previous[from]) return previous;
      const next = { ...previous };
      if (previous[to]) {
        // 目标页签已存在：该页签展示的是目标位置真实内容，不能覆盖；
        // 源页签没有未保存修改（上面已排除 dirty 情况），直接关掉，
        // 避免留下指向已不存在文件的死页签。
        delete next[from];
      } else {
        next[to] = { ...next[from], relPath: to };
        delete next[from];
      }
      return next;
    });
    setActivePath((current) => (current === from ? to : current));
    return { synced: true };
  }, []);

  useEffect(() => {
    touchedRef.current = new Set();
    setFiles({});
    setActivePath('');
  }, [group.key]);

  // 外部改动检测：只盯当前激活的页签，2 秒一轮。
  // 压缩产物（.min.js）会被后台改写，别的工具改文件也一样——
  // 用户切回来看到的必须是磁盘上的真实内容，而不是打开时的快照。
  // 有未保存修改时绝不覆盖：那时用户手上有更新的内容，静默替换等于丢数据。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const relPath = activePathRef.current;
      const state = filesRef.current[relPath];
      // 正在保存或加载时不动，避免和保存流程抢
      if (!state || state.dirty || state.saving || state.loading || state.readOnly) return;
      void (async () => {
        // 先 stat 比 mtime，只有确实变了才整文件读取：
        // 省掉每 2 秒一次的全文件 IO，也降低读到别人半截写入的概率。
        // 取舍：外部工具若写入后回拨/保留 mtime 就检测不到；NTFS 的 mtime
        // 精度是 100ns，正常写入必变，不值得为此再整读一次内容。
        try {
          const info = await window.api.files.stat(groupRef.current.path, relPath);
          const latest = filesRef.current[relPath];
          if (!latest || latest.dirty || latest.saving || latest.loading) return;
          if (!info.exists || Math.abs(info.mtime - latest.mtime) <= 1) return;
        } catch {
          // stat 失败（文件刚被删等）：交给下一轮，不在这里报错
          return;
        }
        // 静默更新：VS Code 也不弹提示，改了就是改了
        await reloadFromDisk(relPath);
      })();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [reloadFromDisk]);

  const active = activePath ? files[activePath] : undefined;
  const openPaths = Object.keys(files);
  const hasDirty = openPaths.some((relPath) => files[relPath].dirty);

  return {
    files,
    openPaths,
    activePath,
    active: active ?? EMPTY,
    hasDirty,
    open,
    update,
    save,
    close,
    closeMany,
    closeAll,
    rename,
    setActivePath,
  };
}
