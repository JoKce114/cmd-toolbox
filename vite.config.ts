import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function developmentCsp(): Plugin {
  return {
    name: 'cmd-toolbox-csp',
    transformIndexHtml(html, ctx) {
      const policy = ctx.server
        ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:5173 http://127.0.0.1:5173"
        : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'";
      return html.replace(
        '<!--CSP-->',
        `<meta http-equiv="Content-Security-Policy" content="${policy}" />`,
      );
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), developmentCsp()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome128',
  },
});
