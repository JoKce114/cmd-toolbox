import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { cn, toErrorMessage } from '../lib';
import type { Group } from '../types';

type SearchMatch = {
  relPath: string;
  line: number;
  text: string;
  column: number;
};

export type SearchPanelProps = {
  group: Group;
  onOpen: (relPath: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
};

// 把命中的词包成 <mark>，长行里能一眼看到匹配位置
function highlight(text: string, query: string, caseSensitive: boolean) {
  const needle = query.trim();
  if (!needle) return text;
  const haystack = caseSensitive ? text : text.toLowerCase();
  const target = caseSensitive ? needle : needle.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let index = haystack.indexOf(target, cursor);
  let key = 0;
  while (index >= 0) {
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(
      <mark className="search-mark" key={key}>
        {text.slice(index, index + needle.length)}
      </mark>,
    );
    key += 1;
    cursor = index + needle.length;
    index = haystack.indexOf(target, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length ? parts : text;
}

export function SearchPanel({ group, onOpen, onClose, onError }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const run = useCallback(
    async (text: string, sensitive: boolean) => {
      if (!text.trim()) {
        setMatches([]);
        setTruncated(false);
        return;
      }
      const requestId = requestRef.current + 1;
      requestRef.current = requestId;
      setSearching(true);
      try {
        const result = await window.api.files.search(group.path, text, { caseSensitive: sensitive });
        if (requestId !== requestRef.current) return;
        setMatches(result.matches);
        setTruncated(result.truncated);
      } catch (error) {
        if (requestId === requestRef.current) onError(toErrorMessage(error));
      } finally {
        if (requestId === requestRef.current) setSearching(false);
      }
    },
    [group.path, onError],
  );

  // 输入停顿后再查，避免每次按键都遍历整个项目
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void run(query, caseSensitive);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [query, caseSensitive, run]);

  const grouped = matches.reduce<Record<string, SearchMatch[]>>((acc, match) => {
    (acc[match.relPath] ||= []).push(match);
    return acc;
  }, {});

  return (
    <div className="search-panel">
      <div className="search-bar">
        <Search size={13} />
        <input
          ref={inputRef}
          value={query}
          placeholder="在整个项目中搜索"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <button
          type="button"
          className={cn('search-case', caseSensitive && 'active')}
          title="区分大小写"
          onClick={() => setCaseSensitive((value) => !value)}
        >
          Aa
        </button>
        <button type="button" className="icon-btn" title="关闭搜索" onClick={onClose}>
          <X size={13} />
        </button>
      </div>

      <div className="search-results">
        {searching ? (
          <p className="search-hint">搜索中…</p>
        ) : !query.trim() ? (
          <p className="search-hint">输入关键词开始搜索</p>
        ) : matches.length === 0 ? (
          <p className="search-hint">没有匹配结果</p>
        ) : (
          <>
            <p className="search-hint">
              共 {matches.length} 处匹配
              {truncated ? '（结果过多，已截断）' : ''}
            </p>
            {Object.entries(grouped).map(([relPath, items]) => (
              <div className="search-file" key={relPath}>
                <button
                  type="button"
                  className="search-file-name"
                  title={relPath}
                  onClick={() => onOpen(relPath)}
                >
                  {relPath}
                  <span className="search-file-count">{items.length}</span>
                </button>
                {items.map((item) => (
                  <button
                    type="button"
                    key={`${item.relPath}:${item.line}:${item.column}`}
                    className="search-hit"
                    title={item.text}
                    onClick={() => onOpen(item.relPath)}
                  >
                    <span className="search-hit-line">{item.line}</span>
                    <span className="search-hit-text">
                      {highlight(item.text, query, caseSensitive)}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
