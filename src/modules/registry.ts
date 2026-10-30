import type { EditorModule } from './catalog';

export type Diagnostic = {
  from: number;
  to: number;
  severity: 'error' | 'warning';
  message: string;
};

export async function runFormat(module: EditorModule, text: string, lang: string) {
  if (module.kind !== 'format') throw new Error(`模块 ${module.id} 不是格式化模块`);
  const impl = await import('./format');
  return impl.format(text, lang);
}

// runMinify / runDiagnose 属于后续任务（压缩、诊断），对应的 ./minify、
// ./diagnose-js、./diagnose-php 尚未创建。现在写死 import 会让 tsc 直接报
// 「找不到模块」，所以等实现落地的任务再把它们加到这里。
