import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load config from the repo-root .env (see <repo>/.env.template) — the
  // single source of all config since the 2026-07-12 consolidation. Server
  // secrets (DeepSeek/GitHub/Vercel/better-auth) also live there now, but
  // only `VITE_*` vars are ever exposed to the client bundle (this config
  // reads just the ports/URLs below), so no secret reaches the browser.
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');

  const serverPort = Number(env.SERVER_PORT ?? 3000);
  const clientPort = Number(env.CLIENT_PORT ?? 5173);
  const serverUrl = env.SERVER_URL ?? `http://localhost:${serverPort}`;
  const isDev = mode === 'development';

  console.log(
    `Vite dev server running on port ${clientPort}, proxying API requests to ${serverUrl}`,
  );

  return {
    plugins: [
      ...[
        isDev ?
          [
            {
              name: 'inject-1p-ignore-dev',
              apply: 'serve', // 只在 dev server 生效,build 时不运行
              transformIndexHtml(html: string) {
                return html.replace('<body', '<body data-1p-ignore');
              },
            },
          ]
        : null,
      ],
      tanstackRouter(),
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: clientPort,
      proxy: {
        '/api': {
          target: serverUrl,
          changeOrigin: true,
        },
      },
    },
    // In dev, leave VITE_API_URL unset so the client uses relative `/api/*`
    // paths and goes through the proxy above (same-origin, no CORS preflight).
    define:
      isDev ?
        {}
      : {
          'import.meta.env.VITE_API_URL': JSON.stringify(serverUrl),
        },
  };
});
