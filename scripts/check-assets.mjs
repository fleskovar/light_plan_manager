// `make assets`: every shipped asset, harness mapping and hcm bundle loads.
//
// The hcm bundles are rendered into a temporary folder that is removed again
// whatever happens, which a POSIX `trap` used to arrange.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function lpm(...args) {
  const result = spawnSync(process.execPath, ['dist/cli/index.js', ...args], { encoding: 'utf8' });
  // Thrown, not exited: process.exit would skip the finally below.
  if (result.status !== 0) throw new Error(`lpm ${args.join(' ')}\n${result.stdout}${result.stderr}`);
}

const bundles = mkdtempSync(path.join(tmpdir(), 'lpm-bundles-'));
try {
  lpm('agent', '--list');
  lpm('hcm', 'build', '--dir', bundles);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rmSync(bundles, { recursive: true, force: true });
}
if (process.exitCode) process.exit();
console.log('Assets, harness mappings and hcm bundles are valid.');
