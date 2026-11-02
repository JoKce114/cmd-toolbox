import { File } from 'lucide-react';
import { cn } from '../lib';
import { displayNameFor } from '../untitledPath';

type OpenEditorsProps = {
  openPaths: string[];
  activePath: string;
  onSelect: (relPath: string) => void;
  // 可选：对比菜单在 Task 9 接上，届时才传
  onContextMenu?: (event: React.MouseEvent, relPath: string) => void;
};

// 「打开的编辑器」列表：与文件树共用 .file-row 样式，点击切换文件。
export function OpenEditors({
  openPaths,
  activePath,
  onSelect,
  onContextMenu,
}: OpenEditorsProps) {
  if (!openPaths.length) {
    return <p className="file-tree-empty">没有打开的文件</p>;
  }

  return (
    <div className="open-editors-list">
      {openPaths.map((relPath) => {
        const name = displayNameFor(relPath);
        return (
          <button
            key={relPath}
            type="button"
            className={cn('file-row', relPath === activePath && 'active')}
            title={relPath}
            onClick={() => onSelect(relPath)}
            onContextMenu={
              onContextMenu ? (event) => onContextMenu(event, relPath) : undefined
            }
          >
            <span className="file-caret-spacer" />
            <File size={13} />
            <span className="file-name">{name}</span>
          </button>
        );
      })}
    </div>
  );
}
