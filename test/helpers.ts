import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BoardPaths, LoadedBoard } from '../src/core/index.js';
import { ISSUE_FILE, initBoard, loadBoard } from '../src/core/index.js';

const created: string[] = [];

/** A throwaway board on disk. Registered for cleanup by `cleanupBoards()`. */
export function makeBoard(template = 'scrum', prefix = 'LP'): BoardPaths {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lpm-test-'));
  created.push(root);
  return initBoard({ root, template, prefix, git: false }).paths;
}

export function cleanupBoards(): void {
  for (const root of created.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

export function reload(paths: BoardPaths): LoadedBoard {
  return loadBoard(paths);
}

/**
 * Write a raw document, as a user editing the folder by hand would.
 * Pass PERIOD_FILE as `fileName` to hand-write a period instead of an issue.
 */
export function writeRawIssue(dir: string, content: string, fileName = ISSUE_FILE): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  writeFileSync(file, content, 'utf8');
  return file;
}

export function boardPath(paths: BoardPaths, ...segments: string[]): string {
  return path.join(paths.boardDir, ...segments);
}
