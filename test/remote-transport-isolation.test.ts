/**
 * LP-293 — the transport layer's boundary, enforced rather than hoped for:
 * nothing under `src/remote/transport/` may import `src/core` or `src/shared`.
 *
 * The transport is the "carrier" half of the plug-and-play split (LP-246): it
 * knows about HTTP, GraphQL and processes, and nothing about boards. One board
 * vocabulary word in here couples the transport to a tracker's naming, and the
 * whole point is that the same connector serves GitHub, Jira, Linear or a fake
 * in tests.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TRANSPORT_DIR = fileURLToPath(new URL('../src/remote/transport/', import.meta.url));

function sourceFiles(): string[] {
  return readdirSync(TRANSPORT_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort();
}

/** Every module specifier a file reaches for: static, side-effect and dynamic imports. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /from\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]!);
    }
  }
  return specifiers;
}

/** `src/core` or `src/shared` reached through any relative spelling. */
function pointsIntoCoreOrShared(specifier: string): boolean {
  return /(^|\/)core(\/|$)/.test(specifier) || /(^|\/)shared(\/|$)/.test(specifier);
}

describe('transport isolation (LP-293)', () => {
  const files = sourceFiles();

  it('contains the transport module', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [file]))(
    '%s imports nothing from src/core or src/shared',
    (file) => {
      const source = readFileSync(join(TRANSPORT_DIR, file), 'utf8');
      for (const specifier of importSpecifiers(source)) {
        expect(pointsIntoCoreOrShared(specifier), `specifier "${specifier}"`).toBe(false);
      }
    },
  );

  it.each(files.map((file) => [file]))(
    '%s reaches only node: builtins and in-folder siblings',
    (file) => {
      const source = readFileSync(join(TRANSPORT_DIR, file), 'utf8');
      for (const specifier of importSpecifiers(source)) {
        const allowed = specifier.startsWith('node:') || specifier.startsWith('./');
        expect(allowed, `specifier "${specifier}"`).toBe(true);
      }
    },
  );
});
