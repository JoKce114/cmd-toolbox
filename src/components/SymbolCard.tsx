import { CornerDownRight, X } from 'lucide-react';
import { describeLocation } from '../symbolLookup';
import type { SymbolMatch } from '../types';

export type SymbolCardState = {
  name: string;
  loading: boolean;
  /** 桥缺失或查询抛异常：功能不可用，与「确实没有定义」区分开 */
  failed: boolean;
  truncated: boolean;
  matches: SymbolMatch[];
};

type SymbolCardProps = {
  card: SymbolCardState;
  onJump: (match: SymbolMatch) => void;
  onClose: () => void;
};

export function SymbolCard({ card, onJump, onClose }: SymbolCardProps) {
  // 加载中不渲染上一轮的候选，避免上层复用状态对象时闪旧内容
  const matches = card.loading ? [] : card.matches;
  const single = matches.length === 1 ? matches[0] : null;

  return (
    <div className="symbol-card">
      <div className="symbol-card-head">
        <span className="symbol-card-name">{card.name}</span>
        <button type="button" className="symbol-card-close" title="关闭" onClick={onClose}>
          <X size={12} />
        </button>
      </div>

      {card.loading ? <p className="symbol-card-empty">正在查找定义…</p> : null}

      {!card.loading && card.failed ? (
        <p className="symbol-card-empty">暂时无法查询定义，请稍后重试</p>
      ) : null}

      {!card.loading && !card.failed && matches.length === 0 ? (
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
            {single.kind === 'variable' ? '跳到赋值' : '跳到定义'}（
            {describeLocation(single)}）
          </button>
        </div>
      ) : null}

      {!single && matches.length > 1 ? (
        <div className="symbol-card-list">
          {matches.map((match) => (
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

      {!card.loading && card.truncated ? (
        // 具体截断原因有多个（文件总数、目录项总数、解析预算），
        // 不要写死数字：写「4000 个文件」会掩盖解析预算先耗尽的情况。
        <p className="symbol-card-note">项目较大，只搜索了一部分，结果可能不完整</p>
      ) : null}
    </div>
  );
}
