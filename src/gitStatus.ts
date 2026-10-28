import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeAllData } from './ptyBus';
import { toErrorMessage } from './lib';
import type { GitStatus, Group } from './types';

const REFRESH_DEBOUNCE = 800;

type GitStatusOptions = {
  isSessionActive?: (sessionId: string) => boolean;
};

export function useGitStatus(activeGroup: Group | null, options: GitStatusOptions = {}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const groupRef = useRef<Group | null>(activeGroup);
  const optionsRef = useRef(options);
  const requestIdRef = useRef(0);

  groupRef.current = activeGroup;
  optionsRef.current = options;

  const refresh = useCallback(async () => {
    const group = groupRef.current;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (!group) {
      setStatus(null);
      setRefreshing(false);
      return;
    }

    setRefreshing(true);
    try {
      // 先静默 fetch，让 ahead/behind 反映远端真实状态；无网络或没有上游时忽略即可
      await window.api.git.fetch(group.path).catch(() => {});
      const next = await window.api.git.status(group.path);
      if (requestId === requestIdRef.current) setStatus(next);
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setStatus({ ok: false, reason: 'error', message: toErrorMessage(error) });
      }
    } finally {
      if (requestId === requestIdRef.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    setStatus(null);
    void refresh();
  }, [activeGroup?.key, refresh]);

  useEffect(() => {
    const handleFocus = () => void refresh();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [refresh]);

  useEffect(() => {
    let timer: number | null = null;
    const unsubscribe = subscribeAllData((sessionId, data) => {
      if (!/[\r\n]/.test(data)) return;
      const isSessionActive = optionsRef.current.isSessionActive;
      if (isSessionActive && !isSessionActive(sessionId)) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void refresh();
      }, REFRESH_DEBOUNCE);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh]);

  return { status, refreshing, refresh, setStatus };
}
