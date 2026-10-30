import type { EditorModule } from './catalog';

export type Diagnostic = {
  from: number;
  to: number;
  severity: 'error' | 'warning';
  message: string;
};

// 按模块 id 分发到对应的诊断实现。动态 import 保证解析器只在真正启用时才加载。
export async function runDiagnose(
  module: EditorModule,
  text: string,
  lang: string,
): Promise<Diagnostic[]> {
  if (module.id === 'diag-php') {
    const { diagnosePhp } = await import('./diagnose-php');
    return diagnosePhp(text);
  }
  if (module.id === 'diag-js') {
    const { diagnoseJs } = await import('./diagnose-js');
    return diagnoseJs(text, lang);
  }
  return [];
}
