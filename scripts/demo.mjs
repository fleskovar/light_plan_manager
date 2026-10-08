// `make demo`: a throwaway board to test against.
//
//   node scripts/demo.mjs <dir> <prefix>
//
// Each step runs the built CLI quietly; a step that fails prints what it said
// and stops, so a broken demo never looks like a finished one.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const [dir = '.demo', P = 'DEMO'] = process.argv.slice(2);
const cli = path.resolve('dist/cli/index.js');

if (existsSync(path.join(dir, '.lpm'))) {
  console.log(`Demo board already at ${dir}. 'make clean-demo' to rebuild it.`);
  process.exit(0);
}
mkdirSync(dir, { recursive: true });

function lpm(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(`lpm ${args.join(' ')}\n${result.stdout}${result.stderr}`);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

// --no-git keeps the throwaway board out of this repository's git setup.
lpm('init', '--template', 'scrum', '--prefix', P, '--no-git');
lpm('new', 'program', '-t', 'Payments platform');
lpm('new', 'epic', '-t', 'Checkout revamp', '-p', `${P}-1`);
lpm('new', 'feature', '-t', 'Guest flow', '-p', `${P}-2`);
lpm('new', 'feature', '-t', 'Returning customers', '-p', `${P}-2`);
lpm('new', 'user_story', '-t', 'Checkout form', '-p', `${P}-3`, '--set', 'story_points=5');
lpm('new', 'user_story', '-t', 'Take payment', '-p', `${P}-3`, '--set', 'story_points=8');
lpm('new', 'user_story', '-t', 'Saved cards', '-p', `${P}-4`, '--set', 'story_points=3');
lpm('new', 'increment', '-t', '2026 H2', '--starts', '2026-07-01', '--ends', '2026-12-31');
lpm('new', 'sprint', '-t', 'Sprint 1', '--starts', '2026-08-03', '--ends', '2026-08-14', '-p', 'TL-1');
lpm('new', 'sprint', '-t', 'Sprint 2', '--starts', '2026-08-17', '--ends', '2026-08-28', '-p', 'TL-1');
lpm('new', 'person', '-t', 'Ada Lovelace');
lpm('new', 'role', '-t', 'Jr. developer', '--capacity', '2');
lpm('link', `${P}-6`, '--depends-on', `${P}-5`);
lpm('link', `${P}-7`, '--depends-on', `${P}-6`);
// Ada can pick up work parked in the pool, so the board has no open work that
// nobody could ever do.
lpm('link', 'RS-1', '--covers', 'RS-2');
lpm('move', `${P}-5`, '--status', 'in_progress', '--assignee', 'RS-1', '--period', 'TL-2');
lpm('move', `${P}-6`, '--period', 'TL-2');
lpm('move', `${P}-7`, '--period', 'TL-3', '--assignee', 'RS-2');
process.stdout.write(lpm('check'));
console.log(`Demo board ready at ${dir}. 'make ui' opens it.`);
