import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyFixes, checkBoard, findBoardPaths, loadBoard } from '../src/core/index.js';
import { cleanupBoards, makeBoard, makeCentralBoard } from './helpers.js';

// `lpm check` warns when the pointer of a project and the `project.json` of
// its central board disagree, and `--fix` writes `project.json` (LPM-7).

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  cleanupBoards();
});

function projectProblems(lpmDirOrProject: string) {
  const board = loadBoard(findBoardPaths(lpmDirOrProject)!);
  return checkBoard(board).filter((problem) => problem.path.endsWith('project.json'));
}

function projectFile(lpmDir: string): unknown {
  return JSON.parse(readFileSync(path.join(lpmDir, 'project.json'), 'utf8'));
}

describe('check on a central board', () => {
  it('reports nothing when project.json names the project', () => {
    const central = makeCentralBoard();
    expect(projectProblems(central.project)).toEqual([]);
  });

  it('warns about a missing project.json and names the file', () => {
    const central = makeCentralBoard({ projectFile: false });

    const problems = projectProblems(central.project);

    expect(problems).toHaveLength(1);
    expect(problems[0]!.level).toBe('warn');
    expect(problems[0]!.path).toMatch(/project\.json$/);
    expect(problems[0]!.message).toMatch(/missing/);
    expect(problems[0]!.fixable).toBe(true);
  });

  it('warns with both paths when project.json names another project', () => {
    const central = makeCentralBoard();
    const other = mkdtempSync(path.join(os.tmpdir(), 'lpm-other-'));
    scratch.push(other);
    writeFileSync(path.join(central.lpmDir, 'project.json'), JSON.stringify({ project_path: other }));

    const problems = projectProblems(central.project);

    expect(problems).toHaveLength(1);
    expect(problems[0]!.level).toBe('warn');
    expect(problems[0]!.message).toContain(other);
    expect(problems[0]!.message).toContain(central.project);
  });
});

describe('check --fix on a central board', () => {
  it('writes project.json with the current project', () => {
    const central = makeCentralBoard();
    const other = mkdtempSync(path.join(os.tmpdir(), 'lpm-other-'));
    scratch.push(other);
    writeFileSync(path.join(central.lpmDir, 'project.json'), JSON.stringify({ project_path: other }));

    const actions = applyFixes(loadBoard(findBoardPaths(central.project)!));

    expect(actions.some((action) => action.includes('project.json'))).toBe(true);
    expect(projectFile(central.lpmDir)).toEqual({ project_path: central.project });
    expect(projectProblems(central.project)).toEqual([]);
  });

  it('creates a missing project.json', () => {
    const central = makeCentralBoard({ projectFile: false });
    applyFixes(loadBoard(findBoardPaths(central.project)!));
    expect(projectFile(central.lpmDir)).toEqual({ project_path: central.project });
  });
});

describe('check on a local board', () => {
  it('adds no message about project.json', () => {
    const local = makeBoard();
    expect(checkBoard(loadBoard(local)).filter((problem) => problem.path.includes('project.json'))).toEqual([]);
  });
});

describe('check on a central board named directly without project.json', () => {
  it('warns, and cannot fix, because no project is known', () => {
    const central = makeCentralBoard();
    unlinkSync(path.join(central.lpmDir, 'project.json'));
    const saved = process.env.LPM_BOARD_PATH;
    process.env.LPM_BOARD_PATH = central.lpmDir;
    try {
      const board = loadBoard(findBoardPaths()!);
      const problems = checkBoard(board).filter((problem) => problem.path.endsWith('project.json'));
      expect(problems).toHaveLength(1);
      expect(problems[0]!.fixable).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.LPM_BOARD_PATH;
      else process.env.LPM_BOARD_PATH = saved;
    }
  });
});
