import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, GitMerge, Plus, Search } from 'lucide-react';
import { cn } from '../lib';
import { Modal } from './Modal';

export type BranchPickerModalProps = {
  branches: string[];
  current: string;
  busy: boolean;
  onSelect: (branch: string) => void;
  onMerge: (branch: string) => void;
  onCreate: () => void;
  onClose: () => void;
};

export function BranchPickerModal({
  branches,
  current,
  busy,
  onSelect,
  onMerge,
  onCreate,
  onClose,
}: BranchPickerModalProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return branches;
    return branches.filter((branch) => branch.toLowerCase().includes(needle));
  }, [branches, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // 让键盘选中项始终留在可视区
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.children[activeIndex];
    if (row instanceof HTMLElement) row.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const pick = (branch: string) => {
    if (busy || branch === current) return;
    onSelect(branch);
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const branch = filtered[activeIndex];
      if (branch) pick(branch);
    }
  };

  return (
    <Modal
      title="切换分支"
      subtitle={`当前分支 ${current || '未知'}`}
      onClose={onClose}
      closeDisabled={busy}
      width={520}
    >
      <div className="branch-picker">
        <div className="branch-picker-search">
          <Search size={14} />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索分支"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        <div className="branch-picker-list" ref={listRef}>
          {filtered.length === 0 ? (
            <p className="branch-picker-empty">没有匹配的分支</p>
          ) : (
            filtered.map((branch, index) => {
              const isCurrent = branch === current;
              return (
                <div
                  key={branch}
                  className={cn(
                    'branch-picker-row',
                    isCurrent && 'is-current',
                    index === activeIndex && 'is-active',
                  )}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <button
                    type="button"
                    className="branch-picker-name"
                    disabled={isCurrent || busy}
                    title={isCurrent ? '当前分支' : `切换到 ${branch}`}
                    onClick={() => pick(branch)}
                  >
                    <span className="branch-picker-text">{branch}</span>
                    {isCurrent ? <Check size={13} /> : null}
                  </button>
                  {isCurrent ? null : (
                    <button
                      type="button"
                      className="branch-picker-merge"
                      title={`把 ${branch} 合并到 ${current}`}
                      disabled={busy}
                      onClick={() => {
                        onMerge(branch);
                        onClose();
                      }}
                    >
                      <GitMerge size={13} />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="branch-picker-footer">
          <button
            type="button"
            className="branch-picker-create"
            disabled={busy}
            onClick={() => {
              onCreate();
              onClose();
            }}
          >
            <Plus size={13} />
            <span>新建分支…</span>
          </button>
          <span className="branch-picker-count">
            {query.trim() ? `${filtered.length} / ${branches.length}` : `${branches.length} 个分支`}
          </span>
        </div>
      </div>
    </Modal>
  );
}
