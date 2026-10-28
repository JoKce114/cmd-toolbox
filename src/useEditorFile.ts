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

export function useEditorFile(group: Group, onError: (message: string) => void) {
  const [file, setFile] = useState<EditorFileState>(EMPTY);
  const groupRef = useRef(group);
  groupRef.current = group;

  const open = useCallback(
    async (relPath: string) => {
      // 开始加载时清空上一份文件的正文与元数据，避免加载期间 Ctrl+S 把旧内容写进新文件
      setFile((previous) => ({
        ...previous,
        relPath,
        content: '',
        savedContent: '',
        encoding: 'utf8',
        crlf: false,
        mtime: 0,
        readOnly: false,
        loading: true,
        saving: false,
        dirty: false,
      }));
      try {
        const result: OpenedFile = await window.api.files.read(groupRef.current.path, relPath);
        setFile({
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
        });
      } catch (error) {
        onError(toErrorMessage(error));
        // 记录失败的路径，供 EditorPane 跳过重试，避免无限读取 + toast
        setFile({ ...EMPTY, failedPath: relPath });
      }
    },
    [onError],
  );

  const update = useCallback((content: string) => {
    setFile((previous) => ({
      ...previous,
      content,
      // CodeMirror 会把 \r\n 规范化成 \n，磁盘内容仍是 \r\n；
      // 直接比较会让 CRLF 文件一打开就是「已修改」状态。
      dirty: normalizeNewlines(content) !== normalizeNewlines(previous.savedContent),
    }));
  }, []);

  const save = useCallback(async () => {
    const current = file;
    if (current.loading || current.readOnly || !current.dirty || !current.relPath) return false;
    // 记录真正写入的正文；保存期间用户继续输入的内容不能被误标为已保存
    const written = current.content;
    // CodeMirror 输出 LF；原文件是 CRLF 时写回要保持原样，否则整个文件的行尾会被改写
    const payload = current.crlf ? written.replace(/\n/g, '\r\n') : written;
    setFile((previous) => ({ ...previous, saving: true }));
    try {
      await window.api.files.write(
        groupRef.current.path,
        current.relPath,
        payload,
        current.encoding,
        current.mtime,
      );
      // 保存成功后刷新本地记录的 mtime，供下一次保存比对
      const after = await window.api.files.read(groupRef.current.path, current.relPath);
      setFile((previous) => {
        if (previous.relPath !== current.relPath) return previous;
        return {
          ...previous,
          savedContent: written,
          dirty: normalizeNewlines(previous.content) !== normalizeNewlines(written),
          saving: false,
          mtime: after.mtime,
        };
      });
      return true;
    } catch (error) {
      onError(toErrorMessage(error));
      setFile((previous) => ({ ...previous, saving: false }));
      return false;
    }
  }, [file, onError]);

  useEffect(() => {
    setFile(EMPTY);
  }, [group.key]);

  return { file, open, update, save };
}
