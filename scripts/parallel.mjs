// `make dev` and `make dev-web`: two long-running processes, stopped together.
//
//   node scripts/parallel.mjs watch
//   node scripts/parallel.mjs web <api-port> <demo-dir>
//
// This replaces `cmd & cmd & wait` with `trap 'kill 0'`, which only a POSIX
// shell has. Ctrl-C reaches both children through the console; when either one
// exits on its own, the other is stopped so nothing is left serving.
import { spawn } from 'node:child_process';

const [mode, port, demo] = process.argv.slice(2);

const plans = {
  watch: () => [
    { command: 'npx tsc -p tsconfig.json --watch --preserveWatchOutput', cwd: '.' },
    { command: 'npm run build -- --watch --logLevel warn', cwd: 'web' },
  ],
  // The Vite server serves the app but has no board behind it, so the API runs
  // beside it. The port has to match the proxy target in web/vite.config.ts.
  web: () => [
    { command: `node ../dist/cli/index.js ui --api-only --port ${port}`, cwd: demo },
    { command: 'npm run dev', cwd: 'web' },
  ],
};

if (!plans[mode]) {
  console.error(`usage: node scripts/parallel.mjs ${Object.keys(plans).join('|')} ...`);
  process.exit(2);
}

const children = plans[mode]().map(({ command, cwd }) =>
  spawn(command, { cwd, shell: true, stdio: 'inherit' }),
);
let stopping = false;
for (const child of children) {
  child.on('exit', (code) => {
    if (stopping) return;
    stopping = true;
    for (const other of children) if (other !== child) other.kill();
    process.exitCode = code ?? 0;
  });
}
