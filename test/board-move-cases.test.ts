import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { BOARD_ENV_VAR, LOCK_TIMEOUT_ENV, USER_HOME_ENV_VAR, findBoardPaths, relocateBoard } from '../src/core/index.js';

// The human-readable cases of `lpm store move`: test/cases/board-move. Each
// case has `inputs/case.json` (the files, the project folder and the target),
// `outputs/tree.txt` (every file after the move, without `home/`), an optional
// `outputs/error.txt` (the start of the expected error) and a README.md that
// says where each file goes. Run one case with:
//   npx vitest run test/board-move-cases.test.ts -t <case name>

const CASES = fileURLToPath(new URL('./cases/board-move/', import.meta.url));
const scratch: string[] = [];

interface Case {
  files: Record<string, string>;
  folders?: string[];
  project: string;
  to: 'central' | 'local';
}

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function slashes(text: string): string {
  return text.split(path.sep).join('/');
}

function fill(text: string, tmp: string): string {
  return text
    .replaceAll('{{tmp}}', slashes(tmp))
    .replaceAll('{{pid}}', String(process.pid))
    .replaceAll('{{host}}', os.hostname())
    .replaceAll('{{now}}', new Date().toISOString());
}

function writeCase(input: Case): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lpm-move-case-'));
  scratch.push(tmp);
  for (const folder of input.folders ?? []) mkdirSync(path.join(tmp, folder), { recursive: true });
  for (const [file, text] of Object.entries(input.files)) {
    const target = path.join(tmp, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, fill(text, tmp), 'utf8');
  }
  return tmp;
}

/** Every file below `tmp`, relative and sorted, without the user folder. */
function tree(tmp: string): string[] {
  return (readdirSync(tmp, { recursive: true, withFileTypes: true }) as Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => slashes(path.relative(tmp, path.join(entry.parentPath, entry.name))))
    .filter((file) => !file.startsWith('home/'))
    .sort();
}

function lines(file: string): string[] {
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
}

describe('board-move cases', () => {
  const names = readdirSync(CASES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it('has at least three cases', () => {
    expect(names.length).toBeGreaterThanOrEqual(3);
  });

  for (const name of names) {
    it(name, () => {
      const dir = path.join(CASES, name);
      const input = JSON.parse(readFileSync(path.join(dir, 'inputs', 'case.json'), 'utf8')) as Case;
      const errorFile = path.join(dir, 'outputs', 'error.txt');
      const tmp = writeCase(input);
      const saved = {
        home: process.env[USER_HOME_ENV_VAR],
        board: process.env[BOARD_ENV_VAR],
        timeout: process.env[LOCK_TIMEOUT_ENV],
      };
      process.env[USER_HOME_ENV_VAR] = path.join(tmp, 'home');
      process.env[LOCK_TIMEOUT_ENV] = '150';
      delete process.env[BOARD_ENV_VAR];
      try {
        const paths = findBoardPaths(path.join(tmp, input.project))!;
        if (existsSync(errorFile)) {
          expect(() => relocateBoard(paths, input.to)).toThrow(lines(errorFile)[0]);
        } else {
          relocateBoard(paths, input.to);
        }
        expect(tree(tmp)).toEqual(lines(path.join(dir, 'outputs', 'tree.txt')));
      } finally {
        for (const [key, value] of [
          [USER_HOME_ENV_VAR, saved.home],
          [BOARD_ENV_VAR, saved.board],
          [LOCK_TIMEOUT_ENV, saved.timeout],
        ] as const) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  }
});
