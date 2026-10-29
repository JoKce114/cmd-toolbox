import { useCallback, useEffect, useRef, useState } from 'react';
import { toErrorMessage } from './lib';
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
    async (relPath: string) => {
      if (!relPath) return;

      // 已经打开过就直接切过去，保留未保存的修改
      if (filesRef.current[relPath]) {
        setActivePath(relPath);
        return;
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
      } catch (error) {
        onError(toErrorMessage(error));
        setFiles((previous) => {
          const next = { ...previous };
          delete next[relPath];
          return next;
        });
        setActivePath((current) => (current === relPath ? '' : current));
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

  const save = useCallback(
    async (relPath: string) => {
      const current = filesRef.current[relPath];
      if (!current || current.loading || current.readOnly || !current.dirty) return false;

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
        return true;
      } catch (error) {
        onError(toErrorMessage(error));
        patch(relPath, { saving: false });
        return false;
      }
    },
    [onError, patch],
  );

  const close = useCallback((relPath: string) => {
    touchedRef.current.delete(relPath);
    setFiles((previous) => {
      const next = { ...previous };
      delete next[relPath];
      return next;
    });
    setActivePath((current) => {
      if (current !== relPath) return current;
      const remaining = Object.keys(filesRef.current).filter((item) => item !== relPath);
      return remaining[remaining.length - 1] || '';
    });
  }, []);

  const closeAll = useCallback(() => {
    setFiles({});
    setActivePath('');
  }, []);

  const rename = useCallback((from: string, to: string) => {
    if (touchedRef.current.delete(from)) touchedRef.current.add(to);
    setFiles((previous) => {
      if (from === to || !previous[from] || previous[to]) return previous;
      const next = { ...previous };
      next[to] = { ...next[from], relPath: to };
      delete next[from];
      return next;
    });
    setActivePath((current) => (current === from ? to : current));
  }, []);

  useEffect(() => {
    touchedRef.current = new Set();
    setFiles({});
    setActivePath('');
  }, [group.key]);

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
    closeAll,
    rename,
    setActivePath,
  };
}
