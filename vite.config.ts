import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

// Read the actual backend port from .server-port file (written by server.ts on startup)
function getServerPort(): number {
  const envPort = Number(process.env.SERVER_PORT || process.env.VITE_PROXY_PORT);
  if (Number.isInteger(envPort) && envPort > 0) {
    return envPort;
  }
  try {
    const portFile = path.resolve(__dirname, '.server-port');
    if (fs.existsSync(portFile)) {
      return parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10) || 4399;
    }
  } catch { }
  return 4399;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${getServerPort()}`,
          changeOrigin: true,
          // Prevent keep-alive issues by setting Connection: close
          headers: {
            Connection: 'close',
          },
          configure: (proxy) => {
            proxy.on('error', (_err, _req, res) => {
              const currentPort = getServerPort();
              console.log(`Proxy error on port ${currentPort}: ${_err.message}`);
              // @ts-ignore
              proxy.options.target = `http://127.0.0.1:${currentPort}`;
              if (res && !res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  error: `后端服务未就绪，请稍候重试 (port ${currentPort})`
                }));
              }
            });
          },
        },
      },
    },
  };
});
