import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BoardError } from '../src/core/errors.js';
import {
  capabilitiesPath,
  DEFAULT_PROBE_MAX_AGE_MS,
  emptyCapabilities,
  isProbe,
  loadCapabilityCache,
  resolveCapabilities,
  saveCapabilityCache,
  type Capabilities,
  type CapabilityCache,
} from '../src/remote/capabilities.js';
import { githubCapabilities } from '../src/remote/providers/github/index.js';
import { cleanupBoards, makeBoard } from './helpers.js';

afterAll(cleanupBoards);

// ---------------------------------------------------------------------------
// A fake connector: the one thing a probe talks to. Canned answers, no network
// — this is what keeps every test here offline (criterion 4).
// ---------------------------------------------------------------------------

function fakeConnector(answers: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const connector = {
    name: 'memory',
    async probe(probeName: string): Promise<unknown> {
      calls.push(probeName);
      if (!(probeName in answers)) {
        throw new Error(`no canned answer for probe "${probeName}"`);
      }
      return answers[probeName];
    },
  };
  return { connector, calls };
}

/** A connector with no `probe` method at all. */
const bareConnector = { name: 'memory' };

function emptyCache(): CapabilityCache {
  return { version: 1, probes: new Map() };
}

/** A declared table with one probed cell and everything else static. */
function declared(): Capabilities {
  return {
    hierarchyDepth: 2,
    nativeTypes: { probe: 'native_types' },
    status: { kind: 'transitions' },
    edges: { dependsOn: true, relatesTo: false },
    customFields: { valueTypes: ['text', 'number'] },
    provisioning: { customFields: true, periods: true, labels: true },
    periods: { native: true, creatable: false },
    comments: { native: true, editable: true, deletable: true },
    incrementalRead: { kind: 'cursor' },
    vocabulary: 'fixed',
  };
}

// ---------------------------------------------------------------------------
// The record is data (criterion 1)
// ---------------------------------------------------------------------------

describe('Capabilities record', () => {
  it('covers the ten aspects the ladder and the scaffold need', () => {
    const table = emptyCapabilities();
    expect(Object.keys(table).sort()).toEqual([
      'comments',
      'customFields',
      'edges',
      'hierarchyDepth',
      'incrementalRead',
      'nativeTypes',
      'periods',
      'provisioning',
      'status',
      // Who names the remote's types and statuses: the platform (`fixed`), or
      // us (`open`, the jsonfile case). The scaffold asks a person only for a
      // vocabulary it genuinely cannot know.
      'vocabulary',
    ]);
  });

  it('isProbe distinguishes a probe marker from a literal value', () => {
    expect(isProbe({ probe: 'native_types' })).toBe(true);
    expect(isProbe(true)).toBe(false);
    expect(isProbe(2)).toBe(false);
    expect(isProbe(null)).toBe(false);
    expect(isProbe({ valueTypes: [] })).toBe(false);
    expect(isProbe('labels')).toBe(false);
  });

  it('emptyCapabilities holds nothing and probes nothing', async () => {
    const table = emptyCapabilities();
    for (const value of Object.values(table)) {
      expect(isProbe(value)).toBe(false);
    }
    const { capabilities, refreshed } = await resolveCapabilities(
      table,
      bareConnector,
      emptyCache(),
    );
    expect(refreshed).toEqual([]);
    expect(capabilities).toEqual(table);
  });

  it('GitHub declares its table, probing only the account-dependent cells', () => {
    // Sub-issues vary by plan and rollout, so the hierarchy depth is probed,
    // never a version constant (LP-309).
    expect(githubCapabilities.hierarchyDepth).toEqual({ probe: 'sub_issues' });
    expect(isProbe(githubCapabilities.nativeTypes)).toBe(true);
    expect(githubCapabilities.status).toEqual({ kind: 'binary', open: 'open', closed: 'closed' });
    expect(githubCapabilities.edges).toEqual({ dependsOn: false, relatesTo: false });
    expect(isProbe(githubCapabilities.customFields)).toBe(true);
    expect(isProbe(githubCapabilities.provisioning)).toBe(true);
    expect(githubCapabilities.periods).toEqual({ native: true, creatable: true });
    expect(githubCapabilities.comments).toEqual({ native: true, editable: true, deletable: true });
    expect(githubCapabilities.incrementalRead).toEqual({ kind: 'since' });
  });
});

// ---------------------------------------------------------------------------
// resolveCapabilities (criterion 2)
// ---------------------------------------------------------------------------

describe('resolveCapabilities', () => {
  it('passes static cells through and answers the probe against the connector', async () => {
    const { connector, calls } = fakeConnector({ native_types: true });
    const { capabilities, cache, refreshed } = await resolveCapabilities(
      declared(),
      connector,
      emptyCache(),
    );

    expect(capabilities.hierarchyDepth).toBe(2);
    expect(capabilities.nativeTypes).toBe(true);
    expect(capabilities.customFields).toEqual({ valueTypes: ['text', 'number'] });
    expect(calls).toEqual(['native_types']);
    expect(refreshed).toEqual(['native_types']);
    // The answer is cached for the next call.
    expect(cache.probes.get('native_types')?.value).toBe(true);
    expect(cache.probes.get('native_types')?.probedAt).toEqual(expect.any(String));
  });

  it('uses a fresh cached answer without touching the connector', async () => {
    const { connector, calls } = fakeConnector({ native_types: true });
    const first = await resolveCapabilities(declared(), connector, emptyCache());

    const { capabilities, refreshed } = await resolveCapabilities(
      declared(),
      connector,
      first.cache,
      { now: () => Date.now() + 1000 },
    );
    expect(capabilities.nativeTypes).toBe(true);
    expect(refreshed).toEqual([]);
    expect(calls).toEqual(['native_types']); // probed exactly once
  });

  it('re-runs a probe whose cached answer is older than the configured age', async () => {
    const { connector, calls } = fakeConnector({ native_types: false });
    const cache: CapabilityCache = {
      version: 1,
      probes: new Map([
        [
          'native_types',
          { probedAt: '2026-01-01T00:00:00.000Z', value: true },
        ],
      ]),
    };
    const now = Date.parse('2026-01-03T00:00:00.000Z');

    const { capabilities, refreshed } = await resolveCapabilities(
      declared(),
      connector,
      cache,
      { now: () => now, maxAgeMs: DEFAULT_PROBE_MAX_AGE_MS },
    );
    expect(capabilities.nativeTypes).toBe(false);
    expect(refreshed).toEqual(['native_types']);
    expect(calls).toEqual(['native_types']);
  });

  it('keeps a cached answer within the configured age', async () => {
    const { connector, calls } = fakeConnector({ native_types: false });
    const cache: CapabilityCache = {
      version: 1,
      probes: new Map([
        ['native_types', { probedAt: '2026-01-02T23:00:00.000Z', value: true }],
      ]),
    };
    const now = Date.parse('2026-01-03T00:00:00.000Z');

    const { capabilities, refreshed } = await resolveCapabilities(
      declared(),
      connector,
      cache,
      { now: () => now, maxAgeMs: DEFAULT_PROBE_MAX_AGE_MS },
    );
    expect(capabilities.nativeTypes).toBe(true);
    expect(refreshed).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('re-runs every probe under `refresh`, ignoring the cache entirely', async () => {
    const { connector, calls } = fakeConnector({ native_types: true });
    const cache: CapabilityCache = {
      version: 1,
      probes: new Map([
        ['native_types', { probedAt: new Date().toISOString(), value: false }],
      ]),
    };

    const { capabilities, refreshed } = await resolveCapabilities(
      declared(),
      connector,
      cache,
      { refresh: true },
    );
    expect(capabilities.nativeTypes).toBe(true);
    expect(refreshed).toEqual(['native_types']);
    expect(calls).toEqual(['native_types']);
  });

  it('refuses a declared probe the connector cannot answer', async () => {
    await expect(resolveCapabilities(declared(), bareConnector, emptyCache())).rejects.toThrow(
      BoardError,
    );
    await expect(resolveCapabilities(declared(), bareConnector, emptyCache())).rejects.toThrow(
      'declares a probe "native_types" but its connector does not answer probes',
    );
  });
});

// ---------------------------------------------------------------------------
// The cache on disk (criterion 2's file, and the corrupt-file guard)
// ---------------------------------------------------------------------------

describe('capability cache on disk', () => {
  it('round-trips through .lpm/remotes/<name>/capabilities.json', async () => {
    const paths = makeBoard('blank', 'LP');
    const { connector } = fakeConnector({ native_types: true });
    const { cache } = await resolveCapabilities(declared(), connector, emptyCache());
    saveCapabilityCache(paths, 'upstream', cache);

    const reloaded = loadCapabilityCache(paths, 'upstream');
    expect(reloaded.probes.get('native_types')?.value).toBe(true);
    expect(reloaded.probes.get('native_types')?.probedAt).toEqual(
      cache.probes.get('native_types')?.probedAt,
    );
    expect(capabilitiesPath(paths, 'upstream')).toContain('remotes');
  });

  it('treats a missing file as an empty cache', () => {
    const paths = makeBoard('blank', 'LP');
    const cache = loadCapabilityCache(paths, 'nowhere');
    expect(cache.version).toBe(1);
    expect(cache.probes.size).toBe(0);
  });

  it('rejects a corrupt file with a BoardError naming the path', () => {
    const paths = makeBoard('blank', 'LP');
    const file = capabilitiesPath(paths, 'upstream');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{ not json', 'utf8');
    expect(() => loadCapabilityCache(paths, 'upstream')).toThrow(BoardError);
  });

  it('rejects a newer cache version rather than guessing', () => {
    const paths = makeBoard('blank', 'LP');
    const file = capabilitiesPath(paths, 'upstream');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 2, probes: {} }), 'utf8');
    expect(() => loadCapabilityCache(paths, 'upstream')).toThrow(
      'was written by a newer version of light-plan',
    );
  });
});
