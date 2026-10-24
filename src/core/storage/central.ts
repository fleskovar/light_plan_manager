import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic.js';
import type { BoardPaths } from './paths.js';
import { CONFIG_FILE, LPM_DIR, PROJECT_FILE, STORE_KEY } from './paths.js';

/**
 * The two files that link a project to its central board.
 *
 * - The pointer: `<project>/.lpm/config.yml` with the one key `store`. The
 *   value is the absolute path of the central board folder.
 * - The back reference: `<central board folder>/project.json` with the key
 *   `project_path`. The value is the absolute path of the project folder.
 *
 * `paths.ts` reads both (`readStorePointer`, `readProjectPath`), because
 * `findBoardPaths` needs them. This module writes them.
 */

/** True when the two paths name the same folder. Windows and macOS do not compare case. */
export function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** True when the board documents are not in `<root>/.lpm`, so the board is in a central store. */
export function isCentralBoard(paths: BoardPaths): boolean {
  return !samePath(paths.lpmDir, path.join(paths.root, LPM_DIR));
}

/** Write `project.json` in a central board folder. */
export function writeProjectFile(lpmDir: string, project: string): void {
  writeFileAtomic(
    path.join(lpmDir, PROJECT_FILE),
    `${JSON.stringify({ project_path: path.resolve(project) }, null, 2)}\n`,
  );
}

/** The text of a pointer file. A comment says what the file is, for a person who opens it. */
export function storePointerText(lpmDir: string): string {
  return [
    '# This project keeps its light-plan board in a central store.',
    '# The board documents are in the folder below. `lpm store` shows it,',
    '# and `lpm store move --to local` moves the board back into this folder.',
    `${STORE_KEY}: ${JSON.stringify(path.resolve(lpmDir))}`,
    '',
  ].join('\n');
}

/** Write the pointer `<project>/.lpm/config.yml` to the central board folder `lpmDir`. */
export function writeStorePointer(project: string, lpmDir: string): string {
  const dir = path.join(project, LPM_DIR);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, CONFIG_FILE);
  writeFileAtomic(file, storePointerText(lpmDir));
  return file;
}
