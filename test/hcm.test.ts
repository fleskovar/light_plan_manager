import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { ROLES, loadAssetFiles } from '../src/cli/commands/agent/assets.js';
import { defaultBundleDir, loadBundles, renderBundles } from '../src/cli/commands/hcm/bundle.js';

/**
 * `lpm hcm`: the bundles are rendered from `assets/`, so what is worth testing
 * is that the rendering is faithful — every asset arrives, at the package's
 * version, in the flavors its roles name — and that hcm itself accepts it.
 */
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lpm-hcm-'));
  dirs.push(dir);
  return dir;
}

function frontmatter(file: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, 'utf8'));
  return (match ? YAML.parse(match[1]!) : {}) as Record<string, unknown>;
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/** hcm is optional on a contributor's machine; CI with it installed runs these. */
const hasHcm = spawnSync('hcm --version', { shell: true, encoding: 'utf8' }).status === 0;

describe('lpm hcm', () => {
  it('ships bundle mappings that parse', () => {
    expect(loadBundles().map((bundle) => bundle.name)).toContain('light-plan');
  });

  it('renders every agent and skill at the package version, flavored by role', () => {
    const dir = tmp();
    const [bundle] = renderBundles(dir, { onPath: true });
    const root = path.join(dir, 'light-plan');

    expect(bundle!.version).toBe(pkg.version);
    const manifest = YAML.parse(readFileSync(path.join(root, 'hcm.yaml'), 'utf8'));
    expect(manifest.version).toBe(pkg.version);
    expect(Object.keys(manifest.flavors).sort()).toEqual([...ROLES].sort());

    for (const asset of loadAssetFiles()) {
      const file =
        asset.kind === 'agents'
          ? path.join(root, 'subagents', asset.basename)
          : path.join(root, 'skills', asset.name, 'SKILL.md');
      expect(existsSync(file), asset.relativePath).toBe(true);
      const front = frontmatter(file);
      expect(front.description).toBe(asset.front?.description);
      expect(front.flavors).toEqual(asset.front?.roles);
      expect(readFileSync(file, 'utf8').endsWith(asset.front!.body)).toBe(true);
    }
  });

  it('points the context at what every flavor installs, and only that', () => {
    const dir = tmp();
    renderBundles(dir, { onPath: true });
    const context = readFileSync(path.join(dir, 'light-plan', 'context', '10-light-plan.md'), 'utf8');

    expect(context.startsWith('## ')).toBe(true);
    for (const asset of loadAssetFiles()) {
      const everywhere = ROLES.every((role) => asset.front?.roles?.includes(role) ?? true);
      expect(context.includes(`\`${asset.name}\``), asset.name).toBe(everywhere);
    }
  });

  it('starts the MCP server by name when lpm is on the PATH', () => {
    const dir = tmp();
    renderBundles(dir, { onPath: true });
    const entry = JSON.parse(readFileSync(path.join(dir, 'light-plan', 'mcp', 'light-plan.json'), 'utf8'));
    expect(entry).toEqual({ command: 'lpm', args: ['mcp'] });
  });

  it('replaces an earlier render, so a deleted asset leaves the bundle', () => {
    const dir = tmp();
    renderBundles(dir, { onPath: true });
    const stale = path.join(dir, 'light-plan', 'skills', 'gone', 'SKILL.md');
    mkdirSync(path.dirname(stale), { recursive: true });
    writeFileSync(stale, 'old');

    renderBundles(dir, { onPath: true });
    expect(existsSync(stale)).toBe(false);
  });

  it('refuses to empty a folder that is not a bundle', () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'light-plan'));
    writeFileSync(path.join(dir, 'light-plan', 'notes.txt'), 'mine');

    expect(() => renderBundles(dir, { onPath: true })).toThrow(/holds no hcm bundle/);
    expect(readFileSync(path.join(dir, 'light-plan', 'notes.txt'), 'utf8')).toBe('mine');
  });

  it('keeps the bundles in the per-user data folder of each platform', () => {
    const home = path.join('h');
    expect(defaultBundleDir({ LOCALAPPDATA: 'L' }, 'win32', home)).toBe(path.join('L', 'light-plan', 'hcm'));
    expect(defaultBundleDir({}, 'darwin', home)).toBe(
      path.join(home, 'Library', 'Application Support', 'light-plan', 'hcm'),
    );
    expect(defaultBundleDir({}, 'linux', home)).toBe(path.join(home, '.local', 'share', 'light-plan', 'hcm'));
    expect(defaultBundleDir({ XDG_DATA_HOME: 'X' }, 'linux', home)).toBe(path.join('X', 'light-plan', 'hcm'));
  });

  it.skipIf(!hasHcm)('renders a bundle hcm validates, with no broken references', () => {
    const dir = tmp();
    renderBundles(dir, { onPath: true });
    const shell = process.platform === 'win32';
    for (const args of [
      ['validate', path.join(dir, 'light-plan')],
      ['refs', 'check', '--path', path.join(dir, 'light-plan')],
    ]) {
      const quoted = shell ? args.map((arg) => `"${arg}"`).join(' ') : '';
      const result = shell
        ? spawnSync(`hcm ${quoted}`, { shell, encoding: 'utf8' })
        : spawnSync('hcm', args, { encoding: 'utf8' });
      expect(result.status, `${args.join(' ')}\n${result.stdout}${result.stderr}`).toBe(0);
    }
  });
});
