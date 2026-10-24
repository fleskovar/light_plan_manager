import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BoardError,
  USER_HOME_ENV_VAR,
  centralBoardsDir,
  centralStorePath,
  setCentralStore,
  unsetCentralStore,
} from '../src/core/index.js';

// The key `central_store` in `settings.json` of the user folder holds the
// absolute path of the central store (LPM-11). Each test has its own user
// folder through `LPM_HOME`, so no test reads `~/.light-plan`.

const scratch: string[] = [];
let home: string;
const savedHome = process.env[USER_HOME_ENV_VAR];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function settings(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(home, 'settings.json'), 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  home = tempDir('lpm-home-');
  process.env[USER_HOME_ENV_VAR] = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env[USER_HOME_ENV_VAR];
  else process.env[USER_HOME_ENV_VAR] = savedHome;
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('centralStorePath', () => {
  it('returns null when settings.json is missing', () => {
    expect(centralStorePath()).toBeNull();
  });

  it('returns null when settings.json has no key central_store', () => {
    writeFileSync(path.join(home, 'settings.json'), '{ "default_template": "kanban" }\n');
    expect(centralStorePath()).toBeNull();
  });
});

describe('setCentralStore', () => {
  it('stores the absolute path and returns it', () => {
    const store = tempDir('lpm-store-');
    const stored = setCentralStore(store);
    expect(stored).toBe(store);
    expect(settings().central_store).toBe(store);
    expect(centralStorePath()).toBe(store);
  });

  it('expands a leading ~ to the home folder', () => {
    const name = path.basename(tempDir('lpm-tilde-'));
    // The folder sits in os.tmpdir(), so this test writes `~/<relative path>`.
    const relative = path.relative(os.homedir(), path.join(os.tmpdir(), name));
    const stored = setCentralStore(`~/${relative.split(path.sep).join('/')}`);
    expect(stored).toBe(path.join(os.tmpdir(), name));
  });

  it('resolves a relative path from the current folder', () => {
    const stored = setCentralStore(path.relative(process.cwd(), tempDir('lpm-rel-')));
    expect(path.isAbsolute(stored)).toBe(true);
  });

  it('keeps the other keys of settings.json', () => {
    writeFileSync(path.join(home, 'settings.json'), '{ "default_template": "kanban" }\n');
    setCentralStore(tempDir('lpm-store-'));
    expect(settings().default_template).toBe('kanban');
  });

  it('throws a BoardError that names the file when the path is a file', () => {
    const file = path.join(tempDir('lpm-file-'), 'notes.txt');
    writeFileSync(file, 'x');
    expect(() => setCentralStore(file)).toThrow(BoardError);
    expect(() => setCentralStore(file)).toThrow(file);
  });

  it('creates a missing folder (assumption: the user means a new folder)', () => {
    const store = path.join(tempDir('lpm-parent-'), 'boards');
    setCentralStore(store);
    expect(statSync(store).isDirectory()).toBe(true);
  });
});

describe('centralBoardsDir', () => {
  it('returns <central_store>/.lpm_central', () => {
    const store = tempDir('lpm-store-');
    setCentralStore(store);
    expect(centralBoardsDir()).toBe(path.join(store, '.lpm_central'));
  });

  it('returns null without the key', () => {
    expect(centralBoardsDir()).toBeNull();
  });

  it('does not create .lpm_central', () => {
    const store = tempDir('lpm-store-');
    setCentralStore(store);
    centralBoardsDir();
    expect(existsSync(path.join(store, '.lpm_central'))).toBe(false);
  });
});

describe('unsetCentralStore', () => {
  it('removes the key and keeps the others', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, 'settings.json'), '{ "default_template": "kanban" }\n');
    setCentralStore(tempDir('lpm-store-'));

    unsetCentralStore();

    expect(settings()).toEqual({ default_template: 'kanban' });
    expect(centralStorePath()).toBeNull();
  });

  it('does nothing when the key is absent', () => {
    expect(() => unsetCentralStore()).not.toThrow();
    expect(centralStorePath()).toBeNull();
  });
});
