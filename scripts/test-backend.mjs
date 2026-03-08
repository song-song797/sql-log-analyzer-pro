import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const portFile = path.join(rootDir, '.server-port');

const originalExists = fs.existsSync(portFile);
const originalContent = originalExists ? fs.readFileSync(portFile, 'utf8') : null;

function restorePortFile() {
  if (originalExists) {
    fs.writeFileSync(portFile, originalContent ?? '', 'utf8');
  } else if (fs.existsSync(portFile)) {
    fs.unlinkSync(portFile);
  }
}

const runner = process.platform === 'win32'
  ? path.join(rootDir, 'node_modules', '.bin', 'tsx.cmd')
  : path.join(rootDir, 'node_modules', '.bin', 'tsx');
const child = spawn(
  process.platform === 'win32' ? `"${runner}" server/server.ts` : `${runner} server/server.ts`,
  [],
  {
  cwd: rootDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    SERVER_PORT: '4399',
  },
});

let restored = false;

function safeRestore() {
  if (restored) {
    return;
  }
  restored = true;
  restorePortFile();
}

child.on('exit', (code, signal) => {
  safeRestore();
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

process.on('exit', safeRestore);
process.on('uncaughtException', (error) => {
  console.error(error);
  safeRestore();
  process.exit(1);
});
