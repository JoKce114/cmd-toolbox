import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { EDITOR_FONT_STACKS } from './prefs';
import type { EditorFontFamily } from './prefs';

// VS Code Light+ 的取色，尽量贴近同一套语义
const vscodeLight = HighlightStyle.define([
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#008000', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword], color: '#af00db' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: '#a31515' },
  { tag: [tags.number, tags.bool, tags.null], color: '#098658' },
  { tag: [tags.variableName, tags.propertyName], color: '#001080' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#795e26' },
  { tag: [tags.className, tags.typeName, tags.namespace], color: '#267f99' },
  { tag: [tags.definition(tags.variableName), tags.definition(tags.propertyName)], color: '#0070c1' },
  { tag: [tags.tagName], color: '#800000' },
  { tag: [tags.attributeName], color: '#e50000' },
  { tag: [tags.attributeValue], color: '#0451a5' },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], color: '#383838' },
  { tag: [tags.meta, tags.processingInstruction], color: '#808080' },
  { tag: [tags.invalid], color: '#cd3131' },
  { tag: [tags.strong], fontWeight: '600' },
  { tag: [tags.emphasis], fontStyle: 'italic' },
  { tag: [tags.heading], color: '#800000', fontWeight: '600' },
  { tag: [tags.link, tags.url], color: '#0451a5', textDecoration: 'underline' },
]);

const lightTheme = EditorView.theme(
  {
    '&': {
      color: '#1f1f1f',
      backgroundColor: '#ffffff',
    },
    '.cm-content': {
      caretColor: '#000000',
      padding: '8px 0',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#000000',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#add6ff',
    },
    '.cm-gutters': {
      backgroundColor: '#ffffff',
      color: '#237893',
      border: 'none',
      paddingRight: '8px',
    },
    '.cm-activeLineGutter': {
      backgroundColor: '#f5f5f5',
      color: '#1f1f1f',
    },
    '.cm-activeLine': {
      backgroundColor: '#f5f5f5',
    },
    '.cm-selectionMatch': {
      backgroundColor: '#e5ebf1',
    },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
      backgroundColor: '#e5ebf1',
      outline: '1px solid #b4b4b4',
    },
    '.cm-searchMatch': {
      backgroundColor: '#ffdf5d',
      outline: '1px solid #d4b106',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: '#ffb84d',
    },
    '.cm-foldPlaceholder': {
      backgroundColor: '#e5ebf1',
      border: 'none',
      color: '#616161',
    },
  },
  { dark: false },
);

// VS Code Dark+ 的取色
const vscodeDark = HighlightStyle.define([
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#6a9955', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword], color: '#c586c0' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: '#ce9178' },
  { tag: [tags.number, tags.bool, tags.null], color: '#b5cea8' },
  { tag: [tags.variableName, tags.propertyName], color: '#9cdcfe' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#dcdcaa' },
  { tag: [tags.className, tags.typeName, tags.namespace], color: '#4ec9b0' },
  { tag: [tags.definition(tags.variableName), tags.definition(tags.propertyName)], color: '#9cdcfe' },
  { tag: [tags.tagName], color: '#569cd6' },
  { tag: [tags.attributeName], color: '#9cdcfe' },
  { tag: [tags.attributeValue], color: '#ce9178' },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], color: '#d4d4d4' },
  { tag: [tags.meta, tags.processingInstruction], color: '#808080' },
  { tag: [tags.invalid], color: '#f44747' },
  { tag: [tags.strong], fontWeight: '600' },
  { tag: [tags.emphasis], fontStyle: 'italic' },
  { tag: [tags.heading], color: '#569cd6', fontWeight: '600' },
  { tag: [tags.link, tags.url], color: '#4fc1ff', textDecoration: 'underline' },
]);

const darkTheme = EditorView.theme(
  {
    '&': {
      color: '#d4d4d4',
      backgroundColor: '#1e1e1e',
    },
    '.cm-content': {
      caretColor: '#aeafad',
      padding: '8px 0',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#aeafad',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#264f78',
    },
    '.cm-gutters': {
      backgroundColor: '#1e1e1e',
      color: '#858585',
      border: 'none',
      paddingRight: '8px',
    },
    '.cm-activeLineGutter': {
      backgroundColor: '#2a2d2e',
      color: '#c6c6c6',
    },
    '.cm-activeLine': {
      backgroundColor: '#2a2d2e',
    },
    '.cm-selectionMatch': {
      backgroundColor: '#3a3d41',
    },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
      backgroundColor: '#3a3d41',
      outline: '1px solid #888',
    },
    '.cm-searchMatch': {
      backgroundColor: '#623315',
      outline: '1px solid #d18616',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: '#9e6a03',
    },
    '.cm-foldPlaceholder': {
      backgroundColor: '#3a3d41',
      border: 'none',
      color: '#c6c6c6',
    },
  },
  { dark: true },
);

export const vscodeLightExtensions = [lightTheme, syntaxHighlighting(vscodeLight)];
export const vscodeDarkExtensions = [darkTheme, syntaxHighlighting(vscodeDark)];

export function themeExtensions(mode: 'light' | 'dark') {
  return mode === 'dark' ? vscodeDarkExtensions : vscodeLightExtensions;
}

// 字号、行高、字体由主题扩展注入。styles.css 里不能再写这三条，
// 静态 CSS 的优先级会盖掉这里的值，表现为「改了设置但没反应」。
//
// 主题必须只创建一次：EditorView.theme() 每次调用都会生成新的 StyleModule，
// 重新配置时 CodeMirror 会把它挂到文档上，而 style-mod 只会往里加规则、
// 从不删除。Ctrl+滚轮每次滚动都会重配外观，若在这里按参数新建主题，
// 每个滚轮刻度都会往文档样式表里累积一份 CSS。所以主题写死为 CSS 变量，
// 由 editorAttributes（facet，重配不产生 StyleModule）注入实际取值。
const appearanceTheme = EditorView.theme({
  '&': {
    fontSize: 'var(--cm-font-size, 13px)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--cm-font-family, monospace)',
    lineHeight: 'var(--cm-line-height, 1.5)',
  },
});

export function editorAppearanceExtension(options: {
  fontSize: number;
  lineHeight: number;
  fontFamily: EditorFontFamily;
}): Extension {
  return [
    appearanceTheme,
    EditorView.editorAttributes.of({
      style:
        `--cm-font-size:${options.fontSize}px;` +
        `--cm-font-family:${EDITOR_FONT_STACKS[options.fontFamily]};` +
        `--cm-line-height:${options.lineHeight}`,
    }),
  ];
}

