import { useCallback, useState } from 'react';

const STORAGE_PREFIX = 'cmd-toolbox.sidebar.collapsed.';

export function useCollapsedSection(id: string, defaultCollapsed = false) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_PREFIX + id);
      return raw === null ? defaultCollapsed : raw === '1';
    } catch {
      return defaultCollapsed;
    }
  });

  const toggle = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(STORAGE_PREFIX + id, next ? '1' : '0');
      } catch {
        // 存不进去只影响下次启动的展开状态，不值得打断交互
      }
      return next;
    });
  }, [id]);

  return [collapsed, toggle] as const;
}
