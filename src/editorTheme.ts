import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { EDITOR_FONT_STACKS } from './prefs';
import type { EditorFontFamily } from './prefs';

// 选区底色必须用与 CodeMirror 基础主题同形的选择器才盖得住。基础主题写的是
// `.ͼ1.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`（5 个类），
// 简写的 `.cm-selectionBackground` 只有 1 个类，优先级不够，永远被它压住。
// 深色下基础主题用 #233，和 #1e1e1e 的背景几乎同色，表现成「选了但看不出选在哪」。
function selectionTheme(active: string, inactive: string) {
  return {
    // 失焦时用暗一档的底色，选中范围仍然看得见
    '&.cm-editor > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
      backgroundColor: inactive,
    },
    '&.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
      backgroundColor: active,
    },
    // 关掉 drawSelection 的兜底路径（原生选区）也要有颜色
    '.cm-content ::selection': { backgroundColor: active },
  };
}

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
    ...selectionTheme('#add6ff', '#e5ebf1'),
    '.cm-content': {
      caretColor: '#000000',
      padding: '8px 0',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#000000',
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
    // 必须半透明：选区层在 z-index -2，比它上面的行内容更靠后，
    // 不透明的当前行底色会把这一行的选区整个盖掉（深色下尤其明显）
    '.cm-activeLine': {
      backgroundColor: 'rgba(0, 0, 0, 0.04)',
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
    '.cm-foldGutter .cm-gutterElement': {
      color: '#9da3ae',
      paddingLeft: '2px',
    },
    '.cm-foldGutter .cm-gutterElement:hover': {
      color: '#1f1f1f',
    },
    '.cm-change-gutter': { width: '14px' },
    '.cm-change-gutter .cm-gutterElement': { display: 'flex', alignItems: 'center' },
    '.cm-change-marker': { position: 'relative', width: '100%', height: '100%' },
    '.cm-change-marker.is-added': {
      width: '3px',
      marginLeft: '5px',
      // 蓝色波浪竖线：SVG 沿纵向绘制，repeat-y 平铺时上下接缝才能连成连续波形
      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='3' height='6'%3E%3Cpath d='M1.5 0 Q3 1.5 1.5 3 T1.5 6' fill='none' stroke='%231e88e5' stroke-width='1.2' stroke-linecap='round'/%3E%3C/svg%3E")`,
      backgroundRepeat: 'repeat-y',
      backgroundSize: '3px 6px',
    },
    '.cm-change-marker.is-modified': {
      borderLeft: '3px solid #e8a33d',
      marginLeft: '5px',
    },
    '.cm-change-triangle': {
      position: 'absolute',
      // 垂直居中随行高变化，不能写死像素；横向占 0-5px，竖条从 5px 开始
      top: '50%',
      transform: 'translateY(-50%)',
      left: '0',
      width: '0',
      height: '0',
      borderTop: '4px solid transparent',
      borderBottom: '4px solid transparent',
      borderLeft: '5px solid #e5484d',
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
    ...selectionTheme('#264f78', '#3a3d41'),
    '.cm-content': {
      caretColor: '#aeafad',
      padding: '8px 0',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#aeafad',
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
    // 同浅色主题：底色必须半透明，否则当前行上的选区看不见
    '.cm-activeLine': {
      backgroundColor: 'rgba(255, 255, 255, 0.05)',
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
    '.cm-foldGutter .cm-gutterElement': {
      color: '#6b7280',
      paddingLeft: '2px',
    },
    '.cm-foldGutter .cm-gutterElement:hover': {
      color: '#e6e6e6',
    },
    '.cm-change-gutter': { width: '14px' },
    '.cm-change-gutter .cm-gutterElement': { display: 'flex', alignItems: 'center' },
    '.cm-change-marker': { position: 'relative', width: '100%', height: '100%' },
    '.cm-change-marker.is-added': {
      width: '3px',
      marginLeft: '5px',
      // 深色主题用 #4fa3ff，与新增色条 / 概览标尺保持一致
      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='3' height='6'%3E%3Cpath d='M1.5 0 Q3 1.5 1.5 3 T1.5 6' fill='none' stroke='%234fa3ff' stroke-width='1.2' stroke-linecap='round'/%3E%3C/svg%3E")`,
      backgroundRepeat: 'repeat-y',
      backgroundSize: '3px 6px',
    },
    '.cm-change-marker.is-modified': {
      borderLeft: '3px solid #e2b436',
      marginLeft: '5px',
    },
    '.cm-change-triangle': {
      position: 'absolute',
      // 垂直居中随行高变化，不能写死像素；横向占 0-5px，竖条从 5px 开始
      top: '50%',
      transform: 'translateY(-50%)',
      left: '0',
      width: '0',
      height: '0',
      borderTop: '4px solid transparent',
      borderBottom: '4px solid transparent',
      borderLeft: '5px solid #f14c4c',
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

