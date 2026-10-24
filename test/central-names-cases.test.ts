import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allocateCentralName } from '../src/core/index.js';

// The human-readable cases of the central folder name rule:
// test/cases/central-names. Each case has `inputs/input.json`
// (`projectName`, `existingNames`), `outputs/expected.json` (`name`) and a
// README.md that walks through the rule. Run one case with:
//   npx vitest run test/central-names-cases.test.ts -t <case name>

const CASES = fileURLToPath(new URL('./cases/central-names/', import.meta.url));

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

describe('central-names cases', () => {
  const names = readdirSync(CASES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it('has at least three cases', () => {
    expect(names.length).toBeGreaterThanOrEqual(3);
  });

  for (const name of names) {
    it(name, () => {
      const input = readJson<{ projectName: string; existingNames: string[] }>(
        path.join(CASES, name, 'inputs', 'input.json'),
      );
      const expected = readJson<{ name: string }>(path.join(CASES, name, 'outputs', 'expected.json'));
      expect({ name: allocateCentralName(input.projectName, input.existingNames) }).toEqual(expected);
    });
  }
});
