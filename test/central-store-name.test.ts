import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { allocateCentralName, createCentralBoardDir } from '../src/core/index.js';

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('createCentralBoardDir', () => {
  it('creates .lpm_central and one new folder for each project of the same name', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lpm-alloc-'));
    scratch.push(root);
    const boards = path.join(root, '.lpm_central');
    const first = path.join(root, 'a', 'shop');
    const second = path.join(root, 'b', 'Shop');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });

    const one = createCentralBoardDir(first, boards);
    const two = createCentralBoardDir(second, boards);

    expect(one).toBe(path.join(boards, 'shop'));
    expect(two).toBe(path.join(boards, 'Shop-2'));
    expect(existsSync(one) && existsSync(two)).toBe(true);
  });
});

// A central board lives in `<central_store>/.lpm_central/<name>`. The name is
// the project folder name, with `-2`, `-3`, ... appended when it is taken
// (LPM-16). The allocator is pure: it gets the names that exist.

/** The characters that Windows refuses in a folder name. */
const REFUSED = /[<>:"/\\|?*\u0000-\u001f]/;

describe('allocateCentralName', () => {
  it('returns the project name when it is free', () => {
    expect(allocateCentralName('shop', [])).toBe('shop');
  });

  it('appends -2 when the name is taken', () => {
    expect(allocateCentralName('shop', ['shop'])).toBe('shop-2');
  });

  it('uses the lowest free suffix', () => {
    expect(allocateCentralName('shop', ['shop', 'shop-2', 'shop-4'])).toBe('shop-3');
  });

  it('treats a name that differs only in case as taken', () => {
    expect(allocateCentralName('Shop', ['shop'])).toBe('Shop-2');
    expect(allocateCentralName('shop', ['SHOP', 'Shop-2'])).toBe('shop-3');
  });

  it('appends a suffix to a name that already ends in one', () => {
    expect(allocateCentralName('shop-2', ['shop-2'])).toBe('shop-2-2');
  });

  it('replaces each character that Windows refuses with -', () => {
    expect(allocateCentralName('a<b>c:d"e/f\\g|h?i*j', [])).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  it('removes dots and spaces at the end, which Windows drops', () => {
    expect(allocateCentralName('shop. ', [])).toBe('shop');
  });

  it('appends -board to a name that Windows reserves for a device', () => {
    expect(allocateCentralName('CON', [])).toBe('CON-board');
    expect(allocateCentralName('nul', [])).toBe('nul-board');
    expect(allocateCentralName('com1', [])).toBe('com1-board');
    expect(allocateCentralName('Lpt9.txt', [])).toBe('Lpt9.txt-board');
    expect(allocateCentralName('console', [])).toBe('console');
  });

  it('returns board for an empty name, . and ..', () => {
    expect(allocateCentralName('', [])).toBe('board');
    expect(allocateCentralName('.', [])).toBe('board');
    expect(allocateCentralName('..', [])).toBe('board');
    expect(allocateCentralName('..', ['board'])).toBe('board-2');
  });

  it('never returns a taken name or a refused character (property)', () => {
    fc.assert(
      fc.property(fc.string(), fc.array(fc.string(), { maxLength: 30 }), (name, existing) => {
        const result = allocateCentralName(name, existing);
        const taken = new Set(existing.map((entry) => entry.toLowerCase()));
        expect(taken.has(result.toLowerCase())).toBe(false);
        expect(REFUSED.test(result)).toBe(false);
        expect(result.length).toBeGreaterThan(0);
        expect(result).not.toMatch(/[. ]$/);
        expect(['.', '..']).not.toContain(result);
      }),
      { numRuns: 500 },
    );
  });

  it('gives each of many projects with one name its own folder (property)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.integer({ min: 1, max: 40 }), (name, count) => {
        const names: string[] = [];
        for (let index = 0; index < count; index++) names.push(allocateCentralName(name, names));
        expect(new Set(names.map((entry) => entry.toLowerCase())).size).toBe(count);
      }),
      { numRuns: 200 },
    );
  });
});
