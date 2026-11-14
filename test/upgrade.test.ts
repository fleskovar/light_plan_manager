import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { NpmRunner } from '../src/cli/experimental-deps.js';
import { compareVersions, installedVersion, upgradeLightPlan } from '../src/cli/self-upgrade.js';

/**
 * `lpm upgrade`: the version comparison, and the npm command that each kind of
 * install gets.
 *
 * No case starts npm. Each case builds a folder that looks like an installed
 * light-plan, and passes a runner that records its arguments and answers
 * `npm root -g`, `npm view` and `npm install`.
 */

const folders: string[] = [];

afterAll(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function tempFolder(): string {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'lpm-upgrade-'));
  folders.push(folder);
  return folder;
}

function writeVersion(root: string, version: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'light-plan', version }));
}

interface Call {
  args: string[];
  cwd: string;
}

/**
 * A runner that answers like npm. `latest` is the registry answer, or null for
 * no answer. `installs` controls whether `npm install` writes the new version.
 */
function fakeNpm(options: {
  globalRoot: string;
  latest: string | null;
  root: string;
  installs?: boolean;
}): { run: NpmRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: NpmRunner = (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === 'root') return { status: 0, stdout: `${options.globalRoot}\n` };
    if (args[0] === 'view') {
      return options.latest === null ? { status: 1, stdout: '' } : { status: 0, stdout: `${options.latest}\n` };
    }
    if (args[0] === 'install') {
      if (options.installs === false) return { status: 1, stdout: '' };
      const spec = args.at(-1)!;
      writeVersion(options.root, spec.slice(spec.lastIndexOf('@') + 1));
      return { status: 0, stdout: '' };
    }
    return { status: 1, stdout: '' };
  };
  return { run, calls };
}

function globalInstall(version: string): { root: string; globalRoot: string } {
  const globalRoot = path.join(tempFolder(), 'node_modules');
  const root = path.join(globalRoot, 'light-plan');
  writeVersion(root, version);
  return { root, globalRoot };
}

describe('compareVersions', () => {
  it('orders by major, minor and patch as numbers', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.9', '0.1.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.1.10', '0.1.10')).toBe(0);
  });

  it('puts a prerelease before the release with the same numbers', () => {
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('0.2.0', '0.2.0-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0-beta.1', '0.1.10')).toBeGreaterThan(0);
  });
});

describe('installedVersion', () => {
  it('reads the version of the package folder, and returns null without a package.json', () => {
    const root = tempFolder();
    expect(installedVersion(root)).toBeNull();
    writeVersion(root, '0.1.10');
    expect(installedVersion(root)).toBe('0.1.10');
  });
});

describe('upgradeLightPlan', () => {
  it('installs the latest version globally for a global install', () => {
    const { root, globalRoot } = globalInstall('0.1.9');
    const npm = fakeNpm({ globalRoot, latest: '0.1.10', root });

    const outcome = upgradeLightPlan({ root, run: npm.run });

    expect(outcome).toEqual({
      kind: 'upgraded',
      from: '0.1.9',
      to: '0.1.10',
      command: 'npm install -g light-plan@0.1.10',
    });
    expect(npm.calls.map((call) => call.args)).toEqual([
      ['root', '-g'],
      ['view', 'light-plan', 'version'],
      ['install', '-g', 'light-plan@0.1.10'],
    ]);
  });

  it('runs a global install outside the package folder, because npm renames that folder', () => {
    const { root, globalRoot } = globalInstall('0.1.9');
    const npm = fakeNpm({ globalRoot, latest: '0.1.10', root });

    upgradeLightPlan({ root, run: npm.run });

    const install = npm.calls.find((call) => call.args[0] === 'install')!;
    expect(path.resolve(install.cwd)).toBe(path.dirname(globalRoot));
  });

  it('installs into the project for a project install', () => {
    const project = tempFolder();
    const root = path.join(project, 'node_modules', 'light-plan');
    writeVersion(root, '0.1.9');
    const npm = fakeNpm({ globalRoot: path.join(tempFolder(), 'node_modules'), latest: '0.1.10', root });

    const outcome = upgradeLightPlan({ root, run: npm.run });

    expect(outcome.kind).toBe('upgraded');
    const install = npm.calls.find((call) => call.args[0] === 'install')!;
    expect(install.args).toEqual(['install', 'light-plan@0.1.10']);
    expect(path.resolve(install.cwd)).toBe(path.resolve(project));
  });

  it('runs no install when the installed version is the latest, or newer', () => {
    for (const [installed, kind] of [
      ['0.1.10', 'current'],
      ['0.2.0', 'ahead'],
    ] as const) {
      const { root, globalRoot } = globalInstall(installed);
      const npm = fakeNpm({ globalRoot, latest: '0.1.10', root });
      expect(upgradeLightPlan({ root, run: npm.run }).kind).toBe(kind);
      expect(npm.calls.some((call) => call.args[0] === 'install')).toBe(false);
    }
  });

  it('with check, reports the newer version and runs no install', () => {
    const { root, globalRoot } = globalInstall('0.1.9');
    const npm = fakeNpm({ globalRoot, latest: '0.1.10', root });

    expect(upgradeLightPlan({ root, run: npm.run, check: true })).toEqual({
      kind: 'available',
      installed: '0.1.9',
      latest: '0.1.10',
      command: 'npm install -g light-plan@0.1.10',
    });
    expect(npm.calls.some((call) => call.args[0] === 'install')).toBe(false);
    expect(installedVersion(root)).toBe('0.1.9');
  });

  it('reports a failure when npm fails, or when the folder does not hold the new version', () => {
    const { root, globalRoot } = globalInstall('0.1.9');
    const failing = fakeNpm({ globalRoot, latest: '0.1.10', root, installs: false });
    expect(upgradeLightPlan({ root, run: failing.run }).kind).toBe('failed');

    // npm exits with 0 and leaves the old version in place.
    const silent: NpmRunner = (args, cwd, capture) =>
      args[0] === 'install' ? { status: 0, stdout: '' } : fakeNpm({ globalRoot, latest: '0.1.10', root }).run(args, cwd, capture);
    expect(upgradeLightPlan({ root, run: silent }).kind).toBe('failed');
  });

  it('reports an unreachable registry and runs no install', () => {
    const { root, globalRoot } = globalInstall('0.1.9');
    const npm = fakeNpm({ globalRoot, latest: null, root });

    expect(upgradeLightPlan({ root, run: npm.run })).toEqual({ kind: 'unreachable', installed: '0.1.9' });
    expect(npm.calls.some((call) => call.args[0] === 'install')).toBe(false);
  });

  it('runs no install for a clone or an npm link, and names the commands to run', () => {
    const root = path.join(tempFolder(), 'light_plan_manager');
    writeVersion(root, '0.1.9');
    const npm = fakeNpm({ globalRoot: path.join(tempFolder(), 'node_modules'), latest: '0.1.10', root });

    const outcome = upgradeLightPlan({ root, run: npm.run });

    expect(outcome).toMatchObject({ kind: 'unmanaged', install: 'checkout', installed: '0.1.9', latest: '0.1.10' });
    expect(npm.calls.some((call) => call.args[0] === 'install')).toBe(false);
  });

  it('runs no install from an npx cache, and names the npx command', () => {
    const root = path.join(tempFolder(), '_npx', 'abc123', 'node_modules', 'light-plan');
    writeVersion(root, '0.1.9');
    const npm = fakeNpm({ globalRoot: path.join(tempFolder(), 'node_modules'), latest: '0.1.10', root });

    const outcome = upgradeLightPlan({ root, run: npm.run });

    expect(outcome).toMatchObject({ kind: 'unmanaged', install: 'manual', command: 'npx light-plan@latest <command>' });
    expect(npm.calls.some((call) => call.args[0] === 'install')).toBe(false);
  });
});
