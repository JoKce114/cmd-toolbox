import { useState } from 'react';
import { Copy } from 'lucide-react';
import type { BlameInfo } from '../blameLookup';
import type { DiffHunk } from '../diffParser';

const RELATIVE_UNITS: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [60, 'second'],
  [60, 'minute'],
  [24, 'hour'],
  [30, 'day'],
  [12, 'month'],
];

function relativeTime(epochSeconds: number): string {
  let value = Math.max(0, Date.now() / 1000 - epochSeconds);
  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
  for (const [step, unit] of RELATIVE_UNITS) {
    if (value < step) return formatter.format(-Math.round(value), unit);
    value /= step;
  }
  return formatter.format(-Math.round(value), 'year');
}

export type BlameCardState = {
  info: BlameInfo;
  hunk: DiffHunk | null;
  // 片段还在取，显示占位而不是「该提交没有可展示的片段」
  loading?: boolean;
};

export function BlameCard({ state }: { state: BlameCardState }) {
  const [copied, setCopied] = useState(false);
  const { info, hunk, loading } = state;
  const shown = hunk ? hunk.lines.slice(0, 40) : [];
  const hidden = hunk ? hunk.lines.length - shown.length : 0;

  return (
    <div className="blame-card">
      <div className="blame-card-head">
        <span className="blame-author">{info.author}</span>
        <span className="blame-time">{relativeTime(info.authorTime)}</span>
      </div>
      <p className="blame-summary">{info.summary || '(无提交信息)'}</p>
      <div className="blame-card-hash">
        <code>{info.short}</code>
        <button
          type="button"
          className="icon-btn blame-copy"
          title="复制提交哈希"
          onClick={() => {
            void navigator.clipboard.writeText(info.hash).then(
              () => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              },
              () => {},
            );
          }}
        >
          <Copy size={12} />
        </button>
        {copied ? <span className="blame-copied">已复制</span> : null}
      </div>
      {shown.length ? (
        <div className="blame-diff">
          {shown.map((line, index) => (
            <div key={index} className={`blame-diff-row is-${line.kind}`}>
              <span className="blame-diff-sign">
                {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
              </span>
              <span className="blame-diff-text">{line.text || ' '}</span>
            </div>
          ))}
          {hidden > 0 ? <div className="blame-diff-more">… 还有 {hidden} 行</div> : null}
        </div>
      ) : loading ? (
        <p className="blame-empty">正在读取这次提交的改动…</p>
      ) : (
        <p className="blame-empty">该提交没有可展示的片段</p>
      )}
    </div>
  );
}
