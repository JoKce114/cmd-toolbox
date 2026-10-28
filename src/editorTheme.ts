import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

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

export const vscodeLightExtensions = [lightTheme, syntaxHighlighting(vscodeLight)];
