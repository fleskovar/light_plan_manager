import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * `lpm template` end to end, against the **built** CLI — so this covers the
 * command wiring, the `--params` file and the messages a person actually reads.
 */
const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

const dirs: string[] = [];
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), 'lpm-tpl-'));
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

/** The registry from the docs: a feature template with three chained stories. */
function seed(): void {
  lpm('template', 'new', 'folder', '-t', 'Delivery', '-d', 'Standard patterns');
  lpm('template', 'new', 'folder', '-t', 'Epic slot', '--parent', 'TPL-1');
  lpm(
    'template',
    'new',
    'feature',
    '-t',
    '{{name}} API',
    '--parent',
    'TPL-2',
    '-d',
    'REST endpoint with tests and docs',
    '--param',
    'name:string:required',
    '--param',
    'owner:string=nobody',
  );
  lpm('template', 'new', 'user_story', '-t', 'Design {{name}}', '--parent', 'TPL-3');
  lpm('template', 'new', 'user_story', '-t', 'Build {{name}}', '--parent', 'TPL-3');
  lpm('link', 'TPL-5', '--depends-on', 'TPL-4');
}

describe('lpm template', () => {
  it('says the registry is empty rather than printing nothing', () => {
    const run = lpm('template', 'list');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('The registry is empty');
    expect(run.stdout).toContain('lpm template new');
  });

  it('creates a folder, then a template inside it', () => {
    expect(lpm('template', 'new', 'folder', '-t', 'Delivery').stdout).toContain('Created TPL-1');
    const made = lpm(
      'template',
      'new',
      'folder',
      '-t',
      'Epic slot',
      '--parent',
      'TPL-1',
    );
    expect(made.status).toBe(0);
    const feature = lpm(
      'template',
      'new',
      'feature',
      '-t',
      '{{name}} API',
      '--parent',
      'TPL-2',
      '-d',
      'A feature and its stories',
      '--param',
      'name:string:required',
    );
    expect(feature.status).toBe(0);
    expect(feature.stdout).toContain('Created TPL-3');
  });

  it('lists only the templates somebody can instantiate', () => {
    seed();
    const run = lpm('template', 'list');
    expect(run.stdout).toContain('TPL-3');
    expect(run.stdout).toContain('REST endpoint with tests and docs');
    expect(run.stdout).toContain('Delivery / Epic slot');
    expect(run.stdout).toContain('parameters: name, owner');
    // The folders and the stories inside the template are not offers.
    expect(run.stdout).not.toContain('TPL-1 ');
    expect(run.stdout).not.toContain('TPL-4');
  });

  it('--all shows the whole registry, folders included', () => {
    seed();
    const run = lpm('template', 'list', '--all');
    for (const id of ['TPL-1', 'TPL-2', 'TPL-3', 'TPL-4', 'TPL-5']) {
      expect(run.stdout).toContain(id);
    }
  });

  it('shows the parameters and the shape a template would create', () => {
    seed();
    const run = lpm('template', 'show', 'TPL-3');
    expect(run.stdout).toContain('name');
    expect(run.stdout).toContain('required');
    expect(run.stdout).toContain('default "nobody"');
    expect(run.stdout).toContain('Design {{name}}');
    expect(run.stdout).toContain('after TPL-4');
  });

  it('applies a template from a JSON parameter file', () => {
    seed();
    lpm('new', 'program', '-t', 'Platform');
    lpm('new', 'epic', '-t', 'Payments', '--parent', 'LP-1');

    const file = path.join(cwd, 'params.json');
    writeFileSync(file, JSON.stringify({ name: 'Payments', owner: 'Ana' }), 'utf8');

    const dry = lpm('template', 'apply', 'TPL-3', '--params', file, '--under', 'LP-2', '--dry-run');
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('Would create 3 documents');
    expect(dry.stdout).toContain('Payments API');

    const run = lpm('template', 'apply', 'TPL-3', '--params', file, '--under', 'LP-2');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('3 documents created');

    expect(lpm('check').status).toBe(0);
    const listed = lpm('template', 'list').stdout;
    // Instantiating never touches the registry.
    expect(listed).toContain('TPL-3');
  });

  it('takes parameters from --set, overriding the file', () => {
    seed();
    lpm('new', 'program', '-t', 'Platform');
    lpm('new', 'epic', '-t', 'Payments', '--parent', 'LP-1');
    const file = path.join(cwd, 'params.json');
    writeFileSync(file, JSON.stringify({ name: 'Wrong' }), 'utf8');

    const run = lpm(
      'template',
      'apply',
      'TPL-3',
      '--params',
      file,
      '--set',
      'name=Refunds',
      '--under',
      'LP-2',
      '--dry-run',
    );
    expect(run.stdout).toContain('Refunds API');
    expect(run.stdout).not.toContain('Wrong');
  });

  it('refuses a missing required parameter, and says which', () => {
    seed();
    lpm('new', 'program', '-t', 'Platform');
    lpm('new', 'epic', '-t', 'Payments', '--parent', 'LP-1');
    const run = lpm('template', 'apply', 'TPL-3', '--under', 'LP-2');
    expect(run.status).toBe(1);
    expect(run.all).toContain('"name" is required');
  });

  it('refuses a parameter file that is not a JSON object', () => {
    seed();
    const file = path.join(cwd, 'params.json');
    writeFileSync(file, '[1, 2]', 'utf8');
    const run = lpm('template', 'apply', 'TPL-3', '--params', file);
    expect(run.status).toBe(1);
    expect(run.all).toContain('JSON object');
  });

  it('refuses a parameter file that is not JSON at all', () => {
    seed();
    const file = path.join(cwd, 'params.json');
    writeFileSync(file, 'name: Payments', 'utf8');
    const run = lpm('template', 'apply', 'TPL-3', '--params', file);
    expect(run.status).toBe(1);
    expect(run.all).toContain('not valid JSON');
  });

  it('refuses a folder inside a template', () => {
    seed();
    const run = lpm('template', 'new', 'folder', '-t', 'Nope', '--parent', 'TPL-3');
    expect(run.status).toBe(1);
    expect(run.all).toContain('folder cannot sit inside');
  });

  it('links two templates and refuses a link out of the registry', () => {
    seed();
    lpm('new', 'program', '-t', 'Platform');
    const bad = lpm('link', 'TPL-4', '--depends-on', 'LP-1');
    expect(bad.status).toBe(1);
    expect(bad.all).toContain('only be linked to another template');
  });

  it('is reachable under its aliases and prints its own help', () => {
    expect(lpm('registry', 'list').status).toBe(0);
    expect(lpm('template', '--help').stdout).toContain('lpm template apply');
    expect(lpm('help', 'template').stdout).toContain('The template registry');
  });

  it('rejects an unknown subcommand', () => {
    const run = lpm('template', 'frobnicate');
    expect(run.status).toBe(1);
    expect(run.all).toContain('Unknown subcommand');
  });
});
