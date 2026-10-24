import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { BOARD_ENV_VAR, findBoardPaths } from '../src/core/index.js';

// The human-readable cases of board resolution: test/cases/board-resolution.
// Each case folder has `inputs/tree.json` (the folders and files to write),
// `outputs/expected.json` (root and lpmDir, or the error) and a README.md that
// explains the result. Run one case with:
//   npx vitest run test/board-resolution-cases.test.ts -t <case name>

const CASES = fileURLToPath(new URL('./cases/board-resolution/', import.meta.url));
const scratch: string[] = [];

interface Tree {
  files: Record<string, string>;
  folders?: string[];
  start: string;
}

type Expected = { root: string; lpmDir: string } | { error: string };

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** Forward slashes, so a case reads the same on every platform. */
function slashes(text: string): string {
  return text.split(path.sep).join('/');
}

/** Write the tree of a case into a new temporary folder, and return the folder. */
function writeTree(tree: Tree): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lpm-case-'));
  scratch.push(tmp);
  for (const folder of tree.folders ?? []) mkdirSync(path.join(tmp, folder), { recursive: true });
  for (const [file, text] of Object.entries(tree.files)) {
    const target = path.join(tmp, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text.replaceAll('{{tmp}}', slashes(tmp)), 'utf8');
  }
  return tmp;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

describe('board-resolution cases', () => {
  const names = readdirSync(CASES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it('has at least three cases', () => {
    expect(names.length).toBeGreaterThanOrEqual(3);
  });

  for (const name of names) {
    it(name, () => {
      const tree = readJson<Tree>(path.join(CASES, name, 'inputs', 'tree.json'));
      const expected = readJson<Expected>(path.join(CASES, name, 'outputs', 'expected.json'));
      const tmp = writeTree(tree);
      const saved = process.env[BOARD_ENV_VAR];
      delete process.env[BOARD_ENV_VAR];
      try {
        if ('error' in expected) {
          let message = '';
          try {
            findBoardPaths(path.join(tmp, tree.start));
          } catch (error) {
            message = slashes((error as Error).message);
          }
          expect(message).toContain(expected.error.replaceAll('{{tmp}}', slashes(tmp)));
          return;
        }
        const paths = findBoardPaths(path.join(tmp, tree.start));
        expect(paths).not.toBeNull();
        expect({
          root: slashes(path.relative(tmp, paths!.root)),
          lpmDir: slashes(path.relative(tmp, paths!.lpmDir)),
        }).toEqual(expected);
      } finally {
        if (saved !== undefined) process.env[BOARD_ENV_VAR] = saved;
      }
    });
  }
});
