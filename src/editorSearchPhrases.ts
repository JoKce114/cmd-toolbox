import { EditorState } from '@codemirror/state';

// CodeMirror 内置搜索面板（Ctrl+F）的文案来自 phrase 表，默认是英文。
// 这里全部换成中文，键必须与 @codemirror/search 里调用 phrase() 的原文一致。
export const searchPhrases = EditorState.phrases.of({
  Find: '查找',
  Replace: '替换',
  next: '下一个',
  previous: '上一个',
  all: '全部选中',
  'match case': '区分大小写',
  regexp: '正则',
  'by word': '整词',
  replace: '替换',
  'replace all': '全部替换',
  close: '关闭',
  'current match': '当前匹配',
  'on line': '位于第',
  'Go to line': '跳转到行',
  go: '跳转',
  'replaced match on line $': '已替换第 $ 行的匹配',
  'replaced $ matches': '已替换 $ 处',
  'Search': '搜索',
});
