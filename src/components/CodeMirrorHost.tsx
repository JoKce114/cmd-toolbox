import { useEffect, useRef } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { languageFor } from '../editorLanguage';
import { vscodeLightExtensions } from '../editorTheme';

export type CodeMirrorHostProps = {
  value: string;
  filePath: string;
  readOnly: boolean;
  onChange: (value: string) => void;
};

export function CodeMirrorHost({ value, filePath, readOnly, onChange }: CodeMirrorHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageRef = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 只在 filePath / readOnly 变化时重建，避免每次按键都销毁编辑器
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          highlightSelectionMatches(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.lineWrapping,
          ...vscodeLightExtensions,
          languageRef.current.of([]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          EditorState.readOnly.of(readOnly),
        ],
      }),
    });
    viewRef.current = view;

    void languageFor(filePath).then((extension) => {
      if (disposed || !extension) return;
      view.dispatch({
        effects: languageRef.current.reconfigure(extension),
      });
    });

    return () => {
      disposed = true;
      view.destroy();
      viewRef.current = null;
    };
    // value 故意不放进依赖：由外部内容变化通过下方 effect 同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, readOnly]);

  // 文件内容被外部替换（如重新加载）时，同步到编辑器
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return <div className="codemirror-host" ref={hostRef} />;
}
