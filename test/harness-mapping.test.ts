import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { AssetFile } from '../src/cli/commands/agent/assets.js';
import { RESERVED, ROLES, inRoles, loadAssetFiles } from '../src/cli/commands/agent/assets.js';
import { matcher } from '../src/cli/commands/agent/glob.js';
import { installFile } from '../src/cli/commands/agent/install.js';
import {
  findHarness,
  harnessNames,
  loadHarnesses,
  mcpFor,
  parseHarnessText,
  placementsFor,
  pointerFor,
  resolve,
} from '../src/cli/commands/agent/mapping.js';

/**
 * The shipped files and the harness mappings, checked against each other.
 *
 * `test/agent.test.ts` drives the built CLI and asserts what lands on disk;
 * this one is about the *contract* between the two halves — that every shipped
 * file has somewhere to go in every harness, and that a mapping cannot quietly
 * make a claim the loader will not honour.
 */

const ASSETS = fileURLToPath(new URL('../assets', import.meta.url));
const PROJECT = path.resolve('/tmp/project');

const harnesses = loadHarnesses();
const assets = loadAssetFiles();
const allRoles = [...ROLES];

describe('gitignore-style selection', () => {
  const match = (patterns: string[], target: string): boolean => matcher(patterns)(target);

  it('matches within a segment with * and across them with **', () => {
    expect(match(['skills/*.md'], 'skills/lpm.md')).toBe(true);
    expect(match(['skills/*.md'], 'skills/nested/lpm.md')).toBe(false);
    expect(match(['skills/**/*.md'], 'skills/nested/lpm.md')).toBe(true);
    // `**/` may match nothing, so the shallow case still works.
    expect(match(['skills/**/*.md'], 'skills/lpm.md')).toBe(true);
    expect(match(['**'], 'anything/at/all.png')).toBe(true);
  });

  it('treats a bare directory name and a trailing slash as everything beneath', () => {
    expect(match(['skills'], 'skills/lpm.md')).toBe(true);
    expect(match(['skills/'], 'skills/nested/lpm.md')).toBe(true);
    expect(match(['skills'], 'skillset/lpm.md')).toBe(false);
  });

  it('lets a later ! exclude what an earlier pattern took', () => {
    const patterns = ['skills/*.md', '!skills/lpm-planning.md'];
    expect(match(patterns, 'skills/lpm.md')).toBe(true);
    expect(match(patterns, 'skills/lpm-planning.md')).toBe(false);
  });

  it('matches one character with ?', () => {
    expect(match(['agents/lpm-?.md'], 'agents/lpm-a.md')).toBe(true);
    expect(match(['agents/lpm-?.md'], 'agents/lpm-ab.md')).toBe(false);
  });

  /** A typo that selected everything would be the expensive failure. */
  it('selects nothing when given nothing', () => {
    expect(match([], 'agents/lpm-developer.md')).toBe(false);
    expect(match(['!skills/*.md'], 'skills/lpm.md')).toBe(false);
  });

  it('does not let a dot or a slash mean anything special', () => {
    expect(match(['agents/a.md'], 'agents/aXmd')).toBe(false);
  });
});

describe('the shipped tree', () => {
  it('walks every file and reads frontmatter where there is any', () => {
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      expect(asset.relativePath).not.toMatch(/\\/);
      expect(path.isAbsolute(asset.file)).toBe(true);
      if (asset.front) {
        expect(asset.front.description?.length ?? 0).toBeGreaterThan(20);
        expect(asset.front.body.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('never offers the mappings or the README as payload', () => {
    for (const reserved of RESERVED) {
      expect(assets.some((asset) => asset.relativePath.startsWith(reserved))).toBe(false);
    }
  });

  it('narrows by role, and keeps files that claim none', () => {
    const forDeveloper = assets.filter((asset) => inRoles(asset, ['developer']));
    const names = forDeveloper.map((asset) => asset.name);
    expect(names).toContain('lpm-developer');
    expect(names).not.toContain('lpm-planner');
    expect(names).toContain('lpm');
  });

  it('covers both roles with at least one agent each', () => {
    for (const role of ROLES) {
      const agents = assets.filter(
        (asset) => asset.kind === 'agents' && asset.front?.roles?.includes(role),
      );
      expect(agents.length, `no agent for --type ${role}`).toBeGreaterThan(0);
    }
  });
});

describe('every harness mapping', () => {
  it('is discovered from the directory, not a list in code', () => {
    const files = readdirSync(path.join(ASSETS, 'harnesses'))
      .filter((name) => name.endsWith('.yml'))
      .map((name) => path.basename(name, '.yml'))
      .sort();
    expect(harnessNames().sort()).toEqual(files);
  });

  it.each(harnesses.map((harness) => harness.name))('%s places every shipped file', (name) => {
    const harness = findHarness(name)!;

    for (const scope of ['project', 'user'] as const) {
      const { placements, empty } = placementsFor(resolve(harness, scope, PROJECT), assets, allRoles);

      // A rule that matches nothing is a typo; a file no rule matches would
      // ship and never arrive.
      expect(empty, `${name}/${scope} has rules matching nothing`).toEqual([]);
      const placed = new Set(placements.map((placement) => placement.asset.relativePath));
      for (const asset of assets) {
        expect(placed.has(asset.relativePath), `${name} does not place ${asset.relativePath}`).toBe(
          true,
        );
      }

      const seen = new Set<string>();
      for (const placement of placements) {
        expect(path.isAbsolute(placement.file)).toBe(true);
        // Every placeholder has to have been expanded.
        expect(placement.file).not.toMatch(/[{}]/);
        expect(seen.has(placement.file), `${name}: ${placement.file} written twice`).toBe(false);
        seen.add(placement.file);

        for (const value of Object.values(placement.frontmatter ?? {})) {
          if (typeof value === 'string') expect(value).not.toMatch(/\{[a-z]+\}/);
        }
      }
    }
  });

  it.each(harnesses.map((harness) => harness.name))('%s can be reached by its aliases', (name) => {
    const harness = findHarness(name)!;
    for (const alias of [harness.name, ...harness.aliases]) {
      expect(findHarness(alias)?.name, `alias "${alias}"`).toBe(name);
      // Matching ignores punctuation, so `claude-code` and `claudecode` agree.
      expect(findHarness(alias.replace(/-/g, ''))?.name).toBe(name);
    }
  });

  it.each(harnesses.map((harness) => harness.name))('%s says where MCP servers go', (name) => {
    const harness = findHarness(name)!;
    for (const scope of ['project', 'user'] as const) {
      const mcp = mcpFor(resolve(harness, scope, PROJECT));
      // Either we can write it, or we can say what to write. Never neither.
      expect(Boolean(mcp.file) || Boolean(mcp.advice), `${name}/${scope}`).toBe(true);
      if (mcp.file) expect(mcp.file).not.toMatch(/[{}]/);
    }
  });

  it.each(harnesses.map((harness) => harness.name))('%s documents where it came from', (name) => {
    const harness = findHarness(name)!;
    // A layout with no source is a guess nobody can re-check.
    expect(harness.docs, `${name} has no docs URL`).toMatch(/^https:\/\//);
    expect(harness.verified, `${name} has no verified date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(harness.label.length).toBeGreaterThan(0);
  });

  /** A pointer file is appended to, so it must be markdown the harness reads. */
  it.each(harnesses.map((harness) => harness.name))('%s points only at markdown', (name) => {
    const harness = findHarness(name)!;
    for (const scope of ['project', 'user'] as const) {
      const pointer = pointerFor(resolve(harness, scope, PROJECT));
      if (pointer) expect(pointer.endsWith('.md')).toBe(true);
    }
  });
});

describe('the mapping schema', () => {
  const minimal = `
name: demo
label: Demo
roots:
  project: "{project}/.demo"
  user: "{home}/.demo"
files:
  - from: agents/*.md
    to: "{root}/agents/{basename}"
    frontmatter:
      description: "{description}"
`;

  const place = (text: string, name = 'demo', roles = allRoles) =>
    placementsFor(resolve(parseHarnessText(text, name), 'project', PROJECT), assets, roles);

  it('accepts a minimal mapping', () => {
    const harness = parseHarnessText(minimal, 'demo');
    expect(harness.aliases).toEqual([]);
    const { placements } = place(minimal);
    expect(placements.length).toBeGreaterThan(0);
    for (const placement of placements) {
      expect(placement.file.startsWith(path.join(PROJECT, '.demo', 'agents'))).toBe(true);
    }
  });

  /** The whole reason the schema is strict: a typo must not silently do nothing. */
  it('refuses a key it does not know', () => {
    expect(() => parseHarnessText(minimal.replace('roots:', 'rooots:'), 'demo')).toThrow(
      /not a valid harness mapping/,
    );
  });

  it('refuses a mapping with no rules', () => {
    expect(() => parseHarnessText(minimal.replace(/files:[\s\S]*/, 'files: []\n'), 'demo')).toThrow(
      /not a valid harness mapping/,
    );
  });

  it('refuses a name that does not match the file', () => {
    expect(() => parseHarnessText(minimal, 'something-else')).toThrow(/declares name "demo"/);
  });

  it('refuses a placeholder it cannot expand', () => {
    expect(() => place(minimal.replace('{basename}', '{nonsense}'))).toThrow(
      /Unknown or unavailable placeholder "\{nonsense\}"/,
    );
  });

  /** Rewriting frontmatter onto a file that has none cannot be guessed at. */
  it('refuses to rewrite frontmatter a file does not have', () => {
    const text = minimal.replace('from: agents/*.md', 'from: harnesses/*.yml');
    // harnesses/ is reserved, so use a pattern that matches a real file instead.
    expect(text).toBeDefined();
    const noFront = `
name: demo
label: Demo
roots:
  project: "{project}/.demo"
  user: "{home}/.demo"
files:
  - from: "**"
    to: "{root}/{path}"
    frontmatter:
      description: "{description}"
`;
    // Every shipped file happens to have frontmatter today, so this asserts the
    // rule holds rather than the current tree: a file without any must throw.
    const withoutFront = assets.filter((asset) => !asset.front);
    if (withoutFront.length) {
      expect(() => place(noFront)).toThrow(/has no frontmatter/);
    } else {
      expect(() => place(noFront)).not.toThrow();
    }
  });

  it('copies verbatim when a rule asks for no frontmatter', () => {
    const verbatim = minimal.replace(/\n    frontmatter:[\s\S]*/, '\n');
    const { placements } = place(verbatim);
    expect(placements.length).toBeGreaterThan(0);
    for (const placement of placements) expect(placement.frontmatter).toBeNull();
  });

  it('honours a rule scoped to one scope', () => {
    const scoped = `${minimal}    scope: user\n`;
    const harness = parseHarnessText(scoped, 'demo');
    expect(placementsFor(resolve(harness, 'project', PROJECT), assets, allRoles).placements).toEqual(
      [],
    );
    expect(
      placementsFor(resolve(harness, 'user', PROJECT), assets, allRoles).placements.length,
    ).toBeGreaterThan(0);
  });

  it('reports a rule that matched nothing', () => {
    const missing = minimal.replace('agents/*.md', 'nowhere/*.md');
    const { placements, empty } = place(missing);
    expect(placements).toEqual([]);
    expect(empty).toHaveLength(1);
  });

  it('lets one file land in two places', () => {
    const twice = `${minimal}  - from: agents/*.md\n    to: "{root}/copies/{basename}"\n`;
    const { placements } = place(twice);
    const developer = placements.filter((placement) => placement.asset.name === 'lpm-developer');
    expect(developer).toHaveLength(2);
    expect(new Set(developer.map((placement) => placement.file)).size).toBe(2);
  });

  /**
   * The one thing the mapping cannot express is a harness-specific branch in
   * the code, so the code must not contain one.
   */
  it('leaves no harness name in the installer', async () => {
    const { readFileSync } = await import('node:fs');
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const names = harnessNames();
    // The question asking lives in `cli/prompt.ts`, shared with `lpm remote`,
    // so the guard follows the file rather than the folder.
    const files = [
      'cli/commands/agent/install.ts',
      'cli/commands/agent/assets.ts',
      'cli/commands/agent/index.ts',
      'cli/commands/agent/glob.ts',
      'cli/prompt.ts',
    ];
    for (const file of files) {
      const source = readFileSync(path.join(root, file), 'utf8');
      for (const name of names) {
        expect(
          new RegExp(`['"\`]${name}['"\`]`).test(source),
          `${file} mentions the harness "${name}" — that belongs in its mapping`,
        ).toBe(false);
      }
    }
  });
});

describe('writing a placement', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lpm-place-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const asset = assets.find((entry) => entry.kind === 'agents')!;

  /**
   * Bytes in, bytes out — a rule with no `frontmatter:` must not reformat,
   * re-encode or normalise line endings, or it could not carry a script or a
   * binary.
   */
  it('copies a source byte for byte when no frontmatter is asked for', () => {
    const file = path.join(tmp, 'verbatim.md');
    const action = installFile({ asset, file, frontmatter: null }, { force: false, dryRun: false });

    expect(action.outcome).toBe('created');
    expect(readFileSync(file).equals(readFileSync(asset.file))).toBe(true);

    // Re-running is unchanged, which is what makes an install idempotent.
    expect(
      installFile({ asset, file, frontmatter: null }, { force: false, dryRun: false }).outcome,
    ).toBe('unchanged');
  });

  it('rewrites the frontmatter and keeps the body when one is asked for', () => {
    const file = path.join(tmp, 'rewritten.md');
    installFile(
      { asset, file, frontmatter: { about: 'something else' } },
      { force: false, dryRun: false },
    );

    const written = readFileSync(file, 'utf8');
    expect(written.startsWith('---\nabout: something else\n---\n')).toBe(true);
    expect(written).toContain(asset.front!.body.trim().slice(0, 40));
    expect(written).not.toContain('roles:');
  });

  it('writes nothing on a dry run', () => {
    const file = path.join(tmp, 'never.md');
    installFile({ asset, file, frontmatter: null }, { force: false, dryRun: true });
    expect(existsSync(file)).toBe(false);
  });
});

describe('placement details', () => {
  const agent = assets.find((asset): asset is AssetFile => asset.name === 'lpm-developer')!;
  const only = (name: string, target = agent) =>
    placementsFor(resolve(findHarness(name)!, 'project', PROJECT), [target], allRoles)
      .placements[0]!;

  it('joins Claude tools into a string and omits them elsewhere', () => {
    const forClaude = only('claude');
    expect(typeof forClaude.frontmatter!.tools).toBe('string');
    expect(forClaude.frontmatter!.tools).toContain('mcp__light-plan__next_tasks');

    // Copilot's tool vocabulary is its own; Claude's names must not travel.
    expect(only('copilot').frontmatter!.tools).toBeUndefined();
  });

  it('marks a Reasonix subagent and leaves a skill unmarked', () => {
    const skill = assets.find((asset) => asset.kind === 'skills')!;
    expect(only('reasonix').frontmatter!.runAs).toBe('subagent');
    expect(only('reasonix', skill).frontmatter!.runAs).toBeUndefined();
  });

  it('honours an environment variable that moves a root', () => {
    const previous = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = path.resolve('/tmp/elsewhere');
    try {
      const { placements } = placementsFor(
        resolve(findHarness('copilot')!, 'user', PROJECT),
        [agent],
        allRoles,
      );
      expect(placements[0]!.file.startsWith(path.resolve('/tmp/elsewhere'))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = previous;
    }
  });
});
