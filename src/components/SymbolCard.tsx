import { CornerDownRight, X } from 'lucide-react';
import { describeLocation } from '../symbolLookup';
import type { SymbolMatch } from '../types';

export type SymbolCardState = {
  name: string;
  loading: boolean;
  truncated: boolean;
  matches: SymbolMatch[];
};

type SymbolCardProps = {
  card: SymbolCardState;
  onJump: (match: SymbolMatch) => void;
  onClose: () => void;
};

export function SymbolCard({ card, onJump, onClose }: SymbolCardProps) {
  const single = card.matches.length === 1 ? card.matches[0] : null;

  return (
    <div className="symbol-card">
      <div className="symbol-card-head">
        <span className="symbol-card-name">{card.name}</span>
        <button type="button" className="symbol-card-close" title="关闭" onClick={onClose}>
          <X size={12} />
        </button>
      </div>

      {card.loading ? <p className="symbol-card-empty">正在查找定义…</p> : null}

      {!card.loading && card.matches.length === 0 ? (
        <p className="symbol-card-empty">没有找到「{card.name}」的定义</p>
      ) : null}

      {single ? (
        <div className="symbol-card-single">
          {single.namespace || single.owner ? (
            <p className="symbol-card-where">
              {[single.namespace, single.owner].filter(Boolean).join('\\')}
            </p>
          ) : null}
          <pre className="symbol-card-signature">{single.signature}</pre>
          {single.doc ? <pre className="symbol-card-doc">{single.doc}</pre> : null}
          <button type="button" className="symbol-card-jump" onClick={() => onJump(single)}>
            <CornerDownRight size={12} />
            跳到定义（{describeLocation(single)}）
          </button>
        </div>
      ) : null}

      {!single && card.matches.length > 1 ? (
        <div className="symbol-card-list">
          {card.matches.map((match) => (
            <button
              type="button"
              key={`${match.relPath}:${match.line}:${match.name}`}
              className="symbol-card-item"
              onClick={() => onJump(match)}
            >
              <span className="symbol-card-item-file">
                {match.relPath.split('/').pop()}:{match.line}
              </span>
              <span className="symbol-card-item-sig">{match.signature}</span>
            </button>
          ))}
        </div>
      ) : null}

      {card.truncated ? (
        <p className="symbol-card-note">已扫描前 4000 个文件，结果可能不完整</p>
      ) : null}
    </div>
  );
}
