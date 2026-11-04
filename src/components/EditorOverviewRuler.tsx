import type { LineChanges } from '../lineChanges';

// 只读展示：按行号占比把变更画成短色条，不参与任何交互
export function EditorOverviewRuler({ changes }: { changes: LineChanges | null }) {
  if (!changes) return null;
  if (!changes.chunks.length && !changes.deletes.length) return null;

  const total = Math.max(1, changes.totalLines);
  const percent = (line: number) => ((line - 1) / total) * 100;

  return (
    <div className="editor-overview-ruler" aria-hidden="true">
      {changes.chunks.map((chunk, index) => (
        <span
          key={`chunk-${chunk.startLine}-${index}`}
          className={`editor-overview-mark is-${chunk.kind}`}
          style={{
            top: `${percent(chunk.startLine)}%`,
            height: `max(3px, ${((chunk.endLine - chunk.startLine + 1) / total) * 100}%)`,
          }}
        />
      ))}
      {changes.deletes.map((anchor, index) => (
        <span
          key={`delete-${anchor.line}-${index}`}
          className="editor-overview-mark is-deleted"
          style={{ top: `${percent(anchor.line)}%` }}
        />
      ))}
    </div>
  );
}
