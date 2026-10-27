import type { Extension } from '@codemirror/state';

const EXTENSION_MAP: Record<string, () => Promise<Extension>> = {
  php: () => import('@codemirror/lang-php').then((m) => m.php()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  htm: () => import('@codemirror/lang-html').then((m) => m.html()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  js: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  mjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  cjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  ts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  tsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  md: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
};

export async function languageFor(filePath: string): Promise<Extension | null> {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const loader = EXTENSION_MAP[ext];
  if (!loader) return null;
  try {
    return await loader();
  } catch {
    return null;
  }
}
