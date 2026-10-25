import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * `lpm library` end to end, against the **built** CLI: add, list, show, set,
 * refs and rm, and the brief of an issue that references a document.
 */
const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

const dirs: string[] = [];
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), 'lpm-lib-'));
  dirs.push(cwd);
  lpm('init', '--no-git', '--prefix', 'LP');
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  all: string;
}

function lpm(...args: string[]): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LPM_BOARD_PATH: '' },
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { status: result.status ?? 0, stdout, stderr, all: stdout + stderr };
}

describe('lpm library', () => {
  it('adds a document from a file, lists it and prints its body alone on stdout', () => {
    writeFileSync(path.join(cwd, 'review.md'), '# Review\n\nCheck the tests first.\n');

    const added = lpm('library', 'new', 'prompts/code-review', '-t', 'Code review prompt', '-d', 'What a reviewer checks', '-f', 'review.md');
    expect(added.status).toBe(0);
    expect(added.stdout).toContain('Added library:prompts/code-review');
    expect(readFileSync(path.join(cwd, '.lpm', 'library', 'prompts', 'code-review.md'), 'utf8')).toContain(
      'title: Code review prompt',
    );

    const list = lpm('library');
    expect(list.stdout).toContain('prompts/code-review  Code review prompt  What a reviewer checks');

    const shown = lpm('library', 'show', 'prompts/code-review');
    expect(shown.stdout).toBe('# Review\n\nCheck the tests first.\n');
    expect(shown.stderr).toContain('Code review prompt');

    const json = JSON.parse(lpm('library', 'list', '--json').stdout) as { id: string; body?: string }[];
    expect(json).toEqual([expect.objectContaining({ id: 'prompts/code-review', ref: 'library:prompts/code-review' })]);
    expect(json[0]!.body).toBeUndefined();
  });

  it('changes a document, names the issues that reference it, and prints it in their brief', () => {
    lpm('library', 'new', 'prd/payments', '-m', '## Goals\n\nTake cards.');
    lpm('new', 'program', '-t', 'Payments', '--related', 'library:prd/payments', '--related', 'src/pay.ts');

    const set = lpm('library', 'set', 'prd/payments', '-d', 'What payments must do');
    expect(set.status).toBe(0);
    expect(lpm('library', 'refs', 'prd/payments').stdout).toContain('LP-');

    const id = /LP-\d+/.exec(lpm('library', 'refs', 'prd/payments').stdout)![0];
    const brief = lpm('instructions', id);
    expect(brief.stdout).toContain('library:prd/payments');
    expect(brief.stdout).toContain('Take cards.');
  });

  it('deletes a document, and lpm check then reports the reference that points at nothing', () => {
    lpm('library', 'new', 'prd/payments');
    lpm('new', 'program', '-t', 'Payments', '--related', 'library:prd/payments');

    const removed = lpm('library', 'rm', 'prd/payments');
    expect(removed.stdout).toContain('Deleted library:prd/payments');
    expect(removed.stdout).toContain('still reference it');

    expect(lpm('check').all).toContain('references library:prd/payments, and .lpm/library/prd/payments.md does not exist');
  });

  it('renames a document and rewrites the reference of the issue', () => {
    lpm('library', 'new', 'prd/payments');
    lpm('new', 'program', '-t', 'Payments', '--related', 'library:prd/payments');

    const moved = lpm('library', 'mv', 'prd/payments', 'requirements/payments');
    expect(moved.status).toBe(0);
    expect(moved.stdout).toContain('Moved library:prd/payments → library:requirements/payments');
    expect(moved.stdout).toMatch(/Rewrote the references of LP-\d+/);
    expect(lpm('library', 'refs', 'requirements/payments').stdout).toMatch(/LP-\d+/);
    expect(lpm('check').all).not.toContain('references library:');

    lpm('library', 'rename', 'requirements/payments', 'spec', '--no-refs');
    expect(lpm('check').all).toContain('references library:requirements/payments');
    expect(lpm('library', 'mv', 'spec').all).toContain('Pass the id to move and the new id');
  });

  it('creates folders, prints the tree, moves a document into a folder and deletes a folder', () => {
    expect(lpm('library', 'mkdir', 'archive/2026').stdout).toContain('Created the folder archive/2026/');
    lpm('library', 'new', 'prd', '-t', 'Payments PRD');
    lpm('library', 'mv', 'prd', 'archive/2026/prd');

    expect(lpm('library', 'tree').stdout).toContain('archive/\n  2026/\n    prd  Payments PRD');
    const json = JSON.parse(lpm('library', 'tree', '--json').stdout) as { folders: string[] };
    expect(json.folders).toEqual(['archive', 'archive/2026']);

    expect(lpm('library', 'rmdir', 'archive').all).toContain('The folder "archive" holds 1 document');
    const removed = lpm('library', 'rmdir', 'archive', '-r');
    expect(removed.stdout).toContain('Deleted the folder archive/');
    expect(removed.stdout).toContain('With 1 document: archive/2026/prd');
    expect(lpm('library', 'tree').stdout).toContain('The library is empty');
  });

  it('refuses an invalid id, an unknown subcommand and an empty change', () => {
    expect(lpm('library', 'new', '../escape').all).toContain('is not a valid library id');
    expect(lpm('library', 'frobnicate').all).toContain('Unknown subcommand "frobnicate"');
    lpm('library', 'new', 'notes');
    expect(lpm('library', 'set', 'notes').all).toContain('Nothing to change');
  });
});
