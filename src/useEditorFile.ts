import { useCallback, useEffect, useRef, useState } from 'react';
import { toErrorMessage } from './lib';
import type { Group, OpenedFile } from './types';

export type EditorFileState = {
  relPath: string;
  content: string;
  savedContent: string;
  encoding: string;
  mtime: number;
  readOnly: boolean;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
};

const EMPTY: EditorFileState = {
  relPath: '',
  content: '',
  savedContent: '',
  encoding: 'utf8',
  mtime: 0,
  readOnly: false,
  loading: false,
  saving: false,
  dirty: false,
};

export function useEditorFile(group: Group, onError: (message: string) => void) {
  const [file, setFile] = useState<EditorFileState>(EMPTY);
  const groupRef = useRef(group);
  groupRef.current = group;

  const open = useCallback(
    async (relPath: string) => {
      setFile((previous) => ({ ...previous, relPath, loading: true }));
      try {
        const result: OpenedFile = await window.api.files.read(groupRef.current.path, relPath);
        setFile({
          relPath,
          content: result.content,
          savedContent: result.content,
          encoding: result.encoding,
          mtime: result.mtime,
          readOnly: result.readOnly,
          loading: false,
          saving: false,
          dirty: false,
        });
      } catch (error) {
        onError(toErrorMessage(error));
        setFile(EMPTY);
      }
    },
    [onError],
  );

  const update = useCallback((content: string) => {
    setFile((previous) => ({
      ...previous,
      content,
      dirty: content !== previous.savedContent,
    }));
  }, []);

  const save = useCallback(async () => {
    const current = file;
    if (!current.relPath || current.readOnly) return false;
    setFile((previous) => ({ ...previous, saving: true }));
    try {
      await window.api.files.write(
        groupRef.current.path,
        current.relPath,
        current.content,
        current.encoding,
        current.mtime,
      );
      // 保存成功后刷新本地记录的 mtime，供下一次保存比对
      const after = await window.api.files.read(groupRef.current.path, current.relPath);
      setFile((previous) => ({
        ...previous,
        savedContent: previous.content,
        dirty: false,
        saving: false,
        mtime: after.mtime,
      }));
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
