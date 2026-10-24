import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USER_HOME_ENV_VAR, initBoard, listCentralBoards } from '../src/core/index.js';

// `listCentralBoards` lists the boards in `<central_store>/.lpm_central` for
// `lpm store list` and the landing page of `lpm ui` (LPM-32).

const scratch: string[] = [];
let home: string;
let store: string;
const savedHome = process.env[USER_HOME_ENV_VAR];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function centralProject(name: string, prefix = 'LP'): string {
  const root = path.join(tempDir('lpm-parent-'), name);
  mkdirSync(root);
  initBoard({ root, prefix, git: false, omni: false, store: 'central' });
  return root;
}

beforeEach(() => {
  home = tempDir('lpm-home-');
  store = tempDir('lpm-store-');
  process.env[USER_HOME_ENV_VAR] = home;
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ central_store: store }));
});

afterEach(() => {
  if (savedHome === undefined) delete process.env[USER_HOME_ENV_VAR];
  else process.env[USER_HOME_ENV_VAR] = savedHome;
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('listCentralBoards', () => {
  it('returns one entry for each board folder, sorted by name', () => {
    centralProject('shop', 'SHOP');
    centralProject('blog', 'BLOG');
    centralProject('shop', 'SHOP2');

    expect(listCentralBoards().map((entry) => entry.name)).toEqual(['blog', 'shop', 'shop-2']);
  });

  it('gives the folder, the key prefix and the project of each board', () => {
    const project = centralProject('shop', 'SHOP');

    const [entry] = listCentralBoards();

    expect(entry).toEqual({
      name: 'shop',
      lpmDir: path.join(store, '.lpm_central', 'shop'),
      keyPrefix: 'SHOP',
      projectPath: project,
      pointerOk: true,
      error: null,
    });
  });

  it('reports pointerOk false when project.json is missing', () => {
    centralProject('shop');
    rmSync(path.join(store, '.lpm_central', 'shop', 'project.json'));
    const [entry] = listCentralBoards();
    expect(entry!.projectPath).toBeNull();
    expect(entry!.pointerOk).toBe(false);
  });

  it('reports pointerOk false when the project folder is gone', () => {
    const project = centralProject('shop');
    rmSync(project, { recursive: true, force: true });
    const [entry] = listCentralBoards();
    expect(entry!.projectPath).toBe(project);
    expect(entry!.pointerOk).toBe(false);
  });

  it('reports pointerOk false when the pointer of the project names another folder', () => {
    const project = centralProject('shop');
    writeFileSync(path.join(project, '.lpm', 'config.yml'), `store: ${JSON.stringify(path.join(store, 'elsewhere'))}\n`);
    const [entry] = listCentralBoards();
    expect(entry!.pointerOk).toBe(false);
  });

  it('skips a folder without config.yml', () => {
    centralProject('shop');
    mkdirSync(path.join(store, '.lpm_central', 'notes'));
    expect(listCentralBoards().map((entry) => entry.name)).toEqual(['shop']);
  });

  it('gives an entry with keyPrefix null and the parse error for a config.yml that does not parse', () => {
    mkdirSync(path.join(store, '.lpm_central', 'broken'), { recursive: true });
    writeFileSync(path.join(store, '.lpm_central', 'broken', 'config.yml'), 'key_prefix: [unclosed\n');

    const [entry] = listCentralBoards();

    expect(entry!.name).toBe('broken');
    expect(entry!.keyPrefix).toBeNull();
    expect(entry!.error).toEqual(expect.any(String));
    expect(entry!.error!.length).toBeGreaterThan(0);
  });

  it('returns an empty list without a central store', () => {
    rmSync(path.join(home, 'settings.json'));
    expect(listCentralBoards()).toEqual([]);
  });

  it('returns an empty list when .lpm_central does not exist yet', () => {
    expect(listCentralBoards()).toEqual([]);
  });
});
