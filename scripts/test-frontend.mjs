import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const runner = process.platform === 'win32'
  ? path.join(rootDir, 'node_modules', '.bin', 'vite.cmd')
  : path.join(rootDir, 'node_modules', '.bin', 'vite');
const child = spawn(
  process.platform === 'win32'
    ? `"${runner}" --port 3000 --host 127.0.0.1 --strictPort`
    : `${runner} --port 3000 --host 127.0.0.1 --strictPort`,
  [],
  {
  cwd: rootDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    SERVER_PORT: '4399',
    DISABLE_HMR: 'true',
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
