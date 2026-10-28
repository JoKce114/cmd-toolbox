import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '../lib';

export type BranchSelectProps = {
  value: string;
  options: string[];
  placeholder?: string;
  hintFor?: (branch: string) => string;
  disabled?: boolean;
  onChange: (branch: string) => void;
};

// 原生 select 在 Windows 上很难看，这里做成带搜索的自定义下拉。
export function BranchSelect({
  value,
  options,
  placeholder = '选择分支',
  hintFor,
  disabled = false,
  onChange,
}: BranchSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(Math.max(0, options.indexOf(value)));
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((branch) => branch.toLowerCase().includes(needle));
  }, [options, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    const list = listRef.current;
    const row = list?.children[activeIndex];
    if (row instanceof HTMLElement) row.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const pick = (branch: string) => {
    onChange(branch);
    setOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const branch = filtered[activeIndex];
      if (branch) pick(branch);
    }
  };

  return (
    <div className={cn('branch-select', open && 'is-open', disabled && 'is-disabled')} ref={rootRef}>
      <button
        type="button"
        className="branch-select-trigger"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={cn('branch-select-value', !value && 'is-placeholder')}>
          {value || placeholder}
        </span>
        {value && hintFor ? <span className="branch-select-hint">{hintFor(value)}</span> : null}
        <ChevronDown size={14} className="branch-select-caret" />
      </button>

      {open ? (
        <div className="branch-select-popup">
          <div className="branch-select-search">
            <Search size={13} />
            <input
              ref={inputRef}
              value={query}
              placeholder="搜索分支"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div className="branch-select-list" ref={listRef}>
            {filtered.length === 0 ? (
              <p className="branch-select-empty">没有匹配的分支</p>
            ) : (
              filtered.map((branch, index) => (
                <button
                  key={branch}
                  type="button"
                  className={cn(
                    'branch-select-option',
                    branch === value && 'is-selected',
                    index === activeIndex && 'is-active',
                  )}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => pick(branch)}
                >
                  <span className="branch-select-option-text">{branch}</span>
                  {branch === value ? <Check size={13} /> : null}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
