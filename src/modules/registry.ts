export type Diagnostic = {
  from: number;
  to: number;
  severity: 'error' | 'warning';
  message: string;
};

// 格式化已移除。压缩走 modules/minify 的 enqueueMinify；
// 诊断在后续任务接入这里，按模块 id 分发到 ./diagnose-js 与 ./diagnose-php。
