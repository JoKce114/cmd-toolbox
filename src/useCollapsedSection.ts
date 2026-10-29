import { useCallback, useState } from 'react';

const STORAGE_PREFIX = 'cmd-toolbox.sidebar.collapsed.';

function persist(id: string, collapsed: boolean) {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + id, collapsed ? '1' : '0');
  } catch {
    // 存不进去只影响下次启动的展开状态，不值得打断交互
  }
}

export function useCollapsedSection(id: string, defaultCollapsed = false) {
  const [collapsed, setCollapsedState] = useState(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_PREFIX + id);
      return raw === null ? defaultCollapsed : raw === '1';
    } catch {
      return defaultCollapsed;
    }
  });

  const toggle = useCallback(() => {
    setCollapsedState((current) => {
      const next = !current;
      persist(id, next);
      return next;
    });
  }, [id]);

  // 操作成功后自动展开（例如收起改动后显示 stash 列表）
  const setCollapsed = useCallback(
    (next: boolean) => {
      setCollapsedState(next);
      persist(id, next);
    },
    [id],
  );

  return [collapsed, toggle, setCollapsed] as const;
}
