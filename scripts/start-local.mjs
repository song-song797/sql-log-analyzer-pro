import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const children = [];

function startProcess(label, script, extraEnv = {}) {
  const env = {
    ...process.env,
    SERVER_PORT: '4399',
    VITE_PROXY_PORT: '4399',
    ...extraEnv,
  };
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/s', '/c', `npm run ${script}`], {
      cwd: rootDir,
      stdio: 'inherit',
      env,
    })
    : spawn('npm', ['run', script], {
      cwd: rootDir,
      stdio: 'inherit',
      env,
    });

  child.on('exit', (code, signal) => {
    if (signal) {
      console.log(`[${label}] exited with signal ${signal}`);
    } else if (code && code !== 0) {
      console.error(`[${label}] exited with code ${code}`);
      shutdown(code);
    }
  });

  children.push(child);
}

let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }

  setTimeout(() => process.exit(exitCode), 250);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}

startProcess('backend', 'server');
startProcess('frontend', 'dev', { DISABLE_HMR: 'false' });

console.log('Local app started.');
console.log('Frontend: http://127.0.0.1:3000');
console.log('Backend:  http://127.0.0.1:4399');
