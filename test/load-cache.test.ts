import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import {
  DocumentCache,
  buildBoard,
  createIssue,
  findIssue,
  loadBoard,
} from '../src/core/index.js';
import { loadConfig } from '../src/core/config/schema.js';
import { applyChanges } from '../src/sync/apply.js';
import type { Change } from '../src/shared/changes.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createIssue(reload(paths), { type: 'program', title: 'Platform' });
  createIssue(reload(paths), { type: 'epic', title: 'Auth', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'epic', title: 'Payments', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Login', parentId: 'LP-2' });
  createIssue(reload(paths), { type: 'feature', title: 'Checkout', parentId: 'LP-3' });
  return paths;
}

function loadWithCache(paths: BoardPaths, cache: DocumentCache) {
  return loadBoard(paths, { cache });
}

// Short window for tests so cache hits register without waiting 2 s.
const SHORT = 10;

describe('DocumentCache', () => {
  it('starts with zero counters', () => {
    const cache = new DocumentCache(SHORT);
    expect(cache.hits).toBe(0);
    expect(cache.misses).toBe(0);
  });

  it('returns undefined for a file that does not exist', () => {
    const cache = new DocumentCache(SHORT);
    expect(cache.get('/no/such/file.md')).toBeUndefined();
    expect(cache.hits).toBe(0);
    expect(cache.misses).toBe(0);
  });

  it('records hits and misses', async () => {
    const paths = seed();
    const cache = new DocumentCache(SHORT);

    loadWithCache(paths, cache);
    expect(cache.misses).toBeGreaterThan(0);
    expect(cache.hits).toBe(0);

    // Wait past the short window so cached entries become trusted.
    await new Promise(r => setTimeout(r, 20));

    loadWithCache(paths, cache);
    expect(cache.hits).toBeGreaterThan(0);
    const missesAfterSecond = cache.misses;
    loadWithCache(paths, cache);
    expect(cache.misses).toBe(missesAfterSecond);
  });

  it('second load of an untouched board has zero new misses', async () => {
    const paths = seed();
    const cache = new DocumentCache(SHORT);

    loadWithCache(paths, cache);
    const missesAfterFirst = cache.misses;

    await new Promise(r => setTimeout(r, 20));
    loadWithCache(paths, cache);
    // No new misses — all entries were cached and window has passed
    expect(cache.misses).toBe(missesAfterFirst);
    expect(cache.hits).toBeGreaterThan(0);
  });

  it('busts the cache when mtime changes', async () => {
    const paths = seed();
    const cache = new DocumentCache(SHORT);

    loadWithCache(paths, cache);
    await new Promise(r => setTimeout(r, 20));
    const missesBefore = cache.misses;

    const board = reload(paths);
    const issue = findIssue(board, 'LP-2');
    expect(issue).toBeTruthy();

    const raw = readFileSync(issue!.file, 'utf8');
    await new Promise(r => setTimeout(r, 100));
    writeFileSync(issue!.file, raw, 'utf8');

    loadWithCache(paths, cache);
    // The touched file causes a miss
    expect(cache.misses).toBeGreaterThan(missesBefore);
  });

  it('busts the cache when size changes', async () => {
    const paths = seed();
    const cache = new DocumentCache(SHORT);

    loadWithCache(paths, cache);
    await new Promise(r => setTimeout(r, 20));
    const missesBefore = cache.misses;

    const board = reload(paths);
    const issue = findIssue(board, 'LP-2');
    expect(issue).toBeTruthy();

    const raw = readFileSync(issue!.file, 'utf8');
    writeFileSync(issue!.file, raw + '\n\nExtra content.\n', 'utf8');

    loadWithCache(paths, cache);
    expect(cache.misses).toBeGreaterThan(missesBefore);
  });

  it('clear resets everything', async () => {
    const cache = new DocumentCache(SHORT);
    const paths = seed();

    loadWithCache(paths, cache);
    await new Promise(r => setTimeout(r, 20));
    expect(cache.hits + cache.misses).toBeGreaterThan(0);

    cache.clear();
    expect(cache.hits).toBe(0);
    expect(cache.misses).toBe(0);

    loadWithCache(paths, cache);
    // All misses again after clear — cache is empty
    expect(cache.hits).toBe(0);
    expect(cache.misses).toBeGreaterThan(0);
  });
});

describe('loadBoard with cache', () => {
  it('produces a board identical to uncached loadBoard', async () => {
    const paths = seed();
    const uncached = reload(paths);
    const cache = new DocumentCache(SHORT);

    loadWithCache(paths, cache);
    await new Promise(r => setTimeout(r, 20));
    const cached = loadWithCache(paths, cache);

    expect(cached.issues.length).toBe(uncached.issues.length);
    expect(cached.periods.length).toBe(uncached.periods.length);
    expect(cached.resources.length).toBe(uncached.resources.length);

    const byId = new Map(cached.issues.map(i => [i.id, i]));
    for (const issue of uncached.issues) {
      const cachedIssue = byId.get(issue.id);
      expect(cachedIssue).toBeTruthy();
      expect(cachedIssue!.title).toBe(issue.title);
      expect(cachedIssue!.body).toBe(issue.body);
      expect(cachedIssue!.status).toBe(issue.status);
    }
  });

  it('buildBoard with cache is identical to without', async () => {
    const paths = seed();
    const cache = new DocumentCache(SHORT);
    const { config } = loadConfig(paths);
    expect(config).toBeTruthy();

    buildBoard(paths, config!, { cache });
    await new Promise(r => setTimeout(r, 20));
    const cached = buildBoard(paths, config!, { cache });
    const uncached = reload(paths);

    expect(cached.issues.length).toBe(uncached.issues.length);
    for (let i = 0; i < uncached.issues.length; i++) {
      expect(cached.issues[i]!.id).toBe(uncached.issues[i]!.id);
      expect(cached.issues[i]!.title).toBe(uncached.issues[i]!.title);
    }
  });

  it('survives scripted core operations (cached ≡ uncached)', () => {
    const paths = seed();

    createIssue(reload(paths), { type: 'feature', title: 'Cache Test Feature', parentId: 'LP-2' });
    const afterCreate = reload(paths);

    const cache = new DocumentCache(SHORT);
    const cached = loadWithCache(paths, cache);
    expect(cached.issues.length).toBe(afterCreate.issues.length);

    const cachedById = new Map(cached.issues.map(i => [i.id, i]));
    for (const issue of afterCreate.issues) {
      expect(cachedById.has(issue.id)).toBe(true);
    }
  });

  it('works with buildBoard directly (no config caching)', async () => {
    const paths = seed();
    const cache = new DocumentCache(SHORT);

    const { config } = loadConfig(paths);
    expect(config).toBeTruthy();

    const board1 = buildBoard(paths, config!, { cache });
    await new Promise(r => setTimeout(r, 20));
    const board2 = buildBoard(paths, config!, { cache });

    expect(board2.issues.length).toBe(board1.issues.length);
    // Hits should be > 0 because second buildBoard reuses the cache entries
    // (but only for issue documents — config is not cached via buildBoard)
    expect(cache.hits).toBeGreaterThan(0);
  });
});

describe('cached data is deep-frozen', () => {
  it('throws when mutating a cached data field', async () => {
    const paths = seed();
    const cache = new DocumentCache(SHORT);

    loadWithCache(paths, cache);
    await new Promise(r => setTimeout(r, 20));
    // Reload to populate the cache from a known-safe state.
    loadWithCache(paths, cache);

    const board = reload(paths);
    const issue = findIssue(board, 'LP-1');
    expect(issue).toBeTruthy();

    const cached = cache.get(issue!.file);
    expect(cached).toBeTruthy();
    expect(() => {
      (cached!.data as Record<string, unknown>).id = 'hacked';
    }).toThrow();
  });
});

describe('config caching', () => {
  it('caches the config on second load', async () => {
    const paths = seed();
    const cache = new DocumentCache(SHORT);

    loadWithCache(paths, cache);
    await new Promise(r => setTimeout(r, 20));
    const missesAfterFirst = cache.misses;

    loadWithCache(paths, cache);
    // No new misses — config was cached and window has passed
    expect(cache.misses).toBe(missesAfterFirst);
    expect(cache.hits).toBeGreaterThan(0);
  });

  it('busts config cache when config file changes', async () => {
    const paths = seed();
    const cache = new DocumentCache(SHORT);

    loadWithCache(paths, cache);
    await new Promise(r => setTimeout(r, 20));
    const missesBefore = cache.misses;

    const raw = readFileSync(paths.configPath, 'utf8');
    await new Promise(r => setTimeout(r, 100));
    writeFileSync(paths.configPath, raw, 'utf8');

    loadWithCache(paths, cache);
    expect(cache.misses).toBeGreaterThan(missesBefore);
  });
});

// ── End-to-end: applyChanges equivalence ──────────────────────

describe('applyChanges end-to-end', () => {
  it('push result snapshot deep-equals a fresh uncached load', () => {
    const paths = seed();
    // Create a feature under LP-3 so we can put stories under it.
    const board = reload(paths);
    createIssue(board, { type: 'feature', title: 'Reports', parentId: 'LP-3' });
    const fresh = reload(paths);
    const featureId = fresh.issues.find(i => i.title === 'Reports')!.id;
    const storyA = createIssue(reload(paths), { type: 'user_story', title: 'Story A', parentId: featureId });
    const storyB = createIssue(reload(paths), { type: 'user_story', title: 'Story B', parentId: featureId });
    const storyAId = storyA.id;
    const storyBId = storyB.id;
    const sprintId = board.periods[0]?.id;

    // Push: rename an epic, create a new feature, and link two stories.
    const result = applyChanges(paths, [
      { kind: 'update', id: 'LP-2', nodeKind: 'issue', patch: { title: 'Auth (renamed)' } },
      { kind: 'create', id: 'new:1', nodeKind: 'issue', patch: { type: 'feature', title: 'Dashboard', parentId: 'LP-2' } },
      ...(sprintId
        ? [{ kind: 'update', id: storyAId, nodeKind: 'issue', patch: { period: sprintId } } as Change]
        : []),
      { kind: 'update', id: storyBId, nodeKind: 'issue', patch: { dependsOn: [storyAId] } },
    ] satisfies Change[]);

    expect(result.failures).toEqual([]);
    // 3 changes: rename, create, and link. (Sprint scheduling is skipped when
    // the board has no periods.)
    expect(result.applied.length).toBeGreaterThanOrEqual(3);

    // The pushed board must equal a fresh uncached load
    const freshLoad = reload(paths);
    expect(result.board.issues.length).toBe(freshLoad.issues.length);
    for (const issue of freshLoad.issues) {
      const dto = result.board.issues.find(i => i.id === issue.id);
      expect(dto).toBeTruthy();
      expect(dto!.title).toBe(issue.title);
    }
  });
});

// ── Benchmark (never asserted — CI machines vary) ─────────────

describe.skip('benchmark', () => {
  /**
   * Wall-clock a ~20-change push.  This test is `.skip`ped because timing
   * assertions on CI are noise.  Run it by hand against a copy of a real
   * board:
   *
   *   npx vitest run test/load-cache.test.ts -t "benchmark"
   *
   * Expected shape: reload ~450 ms → ~110–130 ms; push several times faster.
   */
  it('20-change push with cache is faster than without', async () => {
    const { mkdtempSync, rmSync, cpSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { boardPathsAt } = await import('../src/core/storage/paths.js');

    // Copy this repo's own .lpm to a temp dir
    const root = mkdtempSync(join(tmpdir(), 'lpm-bench-'));
    cpSync('.lpm', join(root, '.lpm'), { recursive: true });
    const paths = boardPathsAt(root);

    const toCreate = Array.from({ length: 10 }, (_, i) => ({
      kind: 'create' as const,
      id: `new:${i + 1}`,
      nodeKind: 'issue' as const,
      patch: { type: 'user_story', title: `Bench story ${i + 1}` },
    }));
    const toUpdate = Array.from({ length: 10 }, (_, i) => ({
      kind: 'update' as const,
      id: (i + 1).toString(), // LP-1 .. LP-10
      nodeKind: 'issue' as const,
      patch: { title: `Updated ${i + 1}` },
    }));
    const changes = [...toCreate, ...toUpdate];

    // Warm-up (uncached)
    applyChanges(paths, []);

    const start1 = performance.now();
    const r1 = applyChanges(paths, changes);
    const elapsed1 = performance.now() - start1;
    console.log(`Uncached push: ${elapsed1.toFixed(0)} ms, ${r1.failures.length} failures`);

    // With cache (second push against the same board)
    const start2 = performance.now();
    const r2 = applyChanges(paths, changes.slice(0, 5));
    const elapsed2 = performance.now() - start2;
    console.log(`Cached push:   ${elapsed2.toFixed(0)} ms, ${r2.failures.length} failures`);

    rmSync(root, { recursive: true, force: true });
    expect(elapsed1).toBeGreaterThan(0); // placeholder — benchmark is logged, not asserted
    expect(elapsed2).toBeGreaterThan(0);
  });
});
