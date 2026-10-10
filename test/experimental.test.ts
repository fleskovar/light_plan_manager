import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  USER_HOME_ENV_VAR,
  experimentalOf,
  loadConfig,
  parseConfigText,
  saveBoardTemplate,
  setExperimental,
  userTemplatePath,
} from '../src/core/index.js';
import {
  experimentalDependencies,
  installCommandLine,
  installMissingDependencies,
  installTarget,
  isInstalled,
  npmGlobalRoot,
  type NpmRunner,
} from '../src/cli/experimental-deps.js';
import { cleanupBoards, makeBoard } from './helpers.js';

/**
 * The experimental features: the key `experimental` in `.lpm/config.yml`, and
 * the packages that `lpm experimental on` installs.
 *
 * No case starts npm. Each case about packages builds a folder that looks like
 * an installed light-plan, and passes a runner that records its arguments.
 */

const folders: string[] = [];

afterAll(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  cleanupBoards();
});

function tempFolder(): string {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'lpm-experimental-'));
  folders.push(folder);
  return folder;
}

describe('the key `experimental`', () => {
  it('is off when the key is absent, and on when the key holds true', () => {
    const paths = makeBoard('scrum', 'LP');
    const text = readFileSync(paths.configPath, 'utf8');

    expect(experimentalOf(parseConfigText(text).config!)).toBe(false);
    expect(experimentalOf(parseConfigText(`${text}\nexperimental: true\n`).config!)).toBe(true);
    expect(experimentalOf(parseConfigText(`${text}\nexperimental: false\n`).config!)).toBe(false);
  });

  it('refuses a value that is not a boolean', () => {
    const paths = makeBoard('scrum', 'LP');
    const parsed = parseConfigText(`${readFileSync(paths.configPath, 'utf8')}\nexperimental: sometimes\n`);
    expect(parsed.config).toBeNull();
    expect(parsed.errors.join(' ')).toContain('experimental');
  });
});

describe('setExperimental', () => {
  it('writes the key with a comment, and removes both again byte for byte', () => {
    const paths = makeBoard('scrum', 'LP');
    const before = readFileSync(paths.configPath, 'utf8');

    expect(setExperimental(paths, true)).toEqual({ experimental: true, previous: false, changed: true });
    const on = readFileSync(paths.configPath, 'utf8');
    expect(on).toMatch(/^experimental: true$/m);
    expect(on).toContain('`lpm experimental off` removes this line.');
    expect(experimentalOf(loadConfig(paths).config!)).toBe(true);

    expect(setExperimental(paths, false)).toEqual({ experimental: false, previous: true, changed: true });
    expect(readFileSync(paths.configPath, 'utf8')).toBe(before);
  });

  it('writes nothing when the board already holds the value', () => {
    const paths = makeBoard('scrum', 'LP');
    const before = readFileSync(paths.configPath, 'utf8');

    expect(setExperimental(paths, false).changed).toBe(false);
    expect(readFileSync(paths.configPath, 'utf8')).toBe(before);

    setExperimental(paths, true);
    const on = readFileSync(paths.configPath, 'utf8');
    expect(setExperimental(paths, true).changed).toBe(false);
    expect(readFileSync(paths.configPath, 'utf8')).toBe(on);
  });

  it('replaces a line that a person wrote, and keeps the lines around it', () => {
    const paths = makeBoard('scrum', 'LP');
    appendFileSync(paths.configPath, '\n# mine\nexperimental: false\n# after\n');

    setExperimental(paths, true);

    expect(readFileSync(paths.configPath, 'utf8')).toMatch(/# mine\nexperimental: true\n# after\n$/);
  });

  it('is left out of a board template', () => {
    const previous = process.env[USER_HOME_ENV_VAR];
    process.env[USER_HOME_ENV_VAR] = tempFolder();
    try {
      const paths = makeBoard('scrum', 'LP');
      setExperimental(paths, true);

      saveBoardTemplate(paths, 'team-flow');

      const text = readFileSync(userTemplatePath('team-flow'), 'utf8');
      expect(text).not.toMatch(/^experimental:/m);
      expect(text).not.toContain('lpm experimental off');
    } finally {
      if (previous === undefined) delete process.env[USER_HOME_ENV_VAR];
      else process.env[USER_HOME_ENV_VAR] = previous;
    }
  });
});

/** A folder that holds a package called light-plan with two optional peers and one required peer. */
function fakePackage(root: string): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'light-plan',
      peerDependencies: { 'jira.js': '^6.2.0', '@scope/agent': '^0.84.1', required: '^1.0.0' },
      peerDependenciesMeta: { 'jira.js': { optional: true }, '@scope/agent': { optional: true } },
    }),
    'utf8',
  );
  return root;
}

/** Put a package where `npm install` puts it. */
function addPackage(modules: string, name: string): void {
  mkdirSync(path.join(modules, name), { recursive: true });
  writeFileSync(path.join(modules, name, 'package.json'), JSON.stringify({ name }), 'utf8');
}

describe('the experimental packages', () => {
  it('are the optional peer dependencies of package.json, and no other peer', () => {
    const root = fakePackage(path.join(tempFolder(), 'clone'));
    expect(experimentalDependencies(root)).toEqual([
      { name: 'jira.js', range: '^6.2.0', installed: false },
      { name: '@scope/agent', range: '^0.84.1', installed: false },
    ]);
  });

  it('are the three packages that this repository declares, and all three are installed here', () => {
    // The repository holds them as dev dependencies, so its own tests run the real clients.
    expect(experimentalDependencies().map((dependency) => [dependency.name, dependency.installed])).toEqual([
      ['@earendil-works/pi-ai', true],
      ['@earendil-works/pi-coding-agent', true],
      ['jira.js', true],
    ]);
  });

  it('count as installed in the node_modules of the package, or of a folder above it', () => {
    const project = tempFolder();
    const root = fakePackage(path.join(project, 'node_modules', 'light-plan'));
    expect(isInstalled('jira.js', root)).toBe(false);

    // Beside light-plan, where a project install and a global install put a peer.
    addPackage(path.join(project, 'node_modules'), 'jira.js');
    expect(isInstalled('jira.js', root)).toBe(true);

    // Inside light-plan, where `npm install --no-save` in a clone puts it.
    addPackage(path.join(root, 'node_modules'), '@scope/agent');
    expect(isInstalled('@scope/agent', root)).toBe(true);
  });
});

describe('where npm installs', () => {
  it('is the clone itself, with --no-save, when light-plan is not in a node_modules folder', () => {
    const root = fakePackage(path.join(tempFolder(), 'clone'));
    expect(installTarget(root, null)).toEqual({ kind: 'checkout', cwd: root, args: ['install', '--no-save'] });
  });

  it('is the project, when light-plan is in the node_modules of a project', () => {
    const project = tempFolder();
    const root = fakePackage(path.join(project, 'node_modules', 'light-plan'));
    expect(installTarget(root, path.join(tempFolder(), 'global'))).toEqual({
      kind: 'project',
      cwd: project,
      args: ['install'],
    });
  });

  it('is the global folder, with -g, when light-plan is in the folder that `npm root -g` names', () => {
    const globalRoot = path.join(tempFolder(), 'lib', 'node_modules');
    const root = fakePackage(path.join(globalRoot, 'light-plan'));
    expect(installTarget(root, globalRoot)).toMatchObject({ kind: 'global', args: ['install', '-g'] });
  });

  it('is nowhere for an npx cache, because npm deletes that folder', () => {
    const root = fakePackage(path.join(tempFolder(), '_npx', 'abc123', 'node_modules', 'light-plan'));
    expect(installTarget(root, null).kind).toBe('manual');
  });

  it('reads the global folder from the last line that npm prints', () => {
    const run: NpmRunner = () => ({ status: 0, stdout: 'npm warn something\n/usr/lib/node_modules\n' });
    expect(npmGlobalRoot(run, '.')).toBe('/usr/lib/node_modules');
    expect(npmGlobalRoot(() => ({ status: null, stdout: '' }), '.')).toBeNull();
  });
});

describe('installMissingDependencies', () => {
  /** A runner that records each call. `install` says what an install does on disk. */
  function recorder(install: (cwd: string) => number = () => 0): { run: NpmRunner; calls: Array<{ args: string[]; cwd: string }> } {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const run: NpmRunner = (args, cwd) => {
      calls.push({ args, cwd });
      return args[0] === 'root' ? { status: 0, stdout: '/nowhere/node_modules\n' } : { status: install(cwd), stdout: '' };
    };
    return { run, calls };
  }

  it('installs each missing package with its range, in the folder that Node resolves from', () => {
    const root = fakePackage(path.join(tempFolder(), 'clone'));
    addPackage(path.join(root, 'node_modules'), 'jira.js');
    const { run, calls } = recorder((cwd) => {
      addPackage(path.join(cwd, 'node_modules'), '@scope/agent');
      return 0;
    });

    const outcome = installMissingDependencies({ root, run, nodeMajor: 22 });

    expect(calls).toEqual([{ args: ['install', '--no-save', '@scope/agent@^0.84.1'], cwd: root }]);
    expect(outcome).toEqual({
      kind: 'installed',
      packages: ['@scope/agent'],
      command: 'npm install --no-save "@scope/agent@^0.84.1"',
    });
  });

  it('asks npm for the global folder only when light-plan is in a node_modules folder', () => {
    const project = tempFolder();
    const root = fakePackage(path.join(project, 'node_modules', 'light-plan'));
    const { run, calls } = recorder((cwd) => {
      addPackage(path.join(cwd, 'node_modules'), 'jira.js');
      addPackage(path.join(cwd, 'node_modules'), '@scope/agent');
      return 0;
    });

    expect(installMissingDependencies({ root, run, nodeMajor: 22 }).kind).toBe('installed');

    expect(calls.map((call) => call.args[0])).toEqual(['root', 'install']);
    expect(calls[1]).toEqual({ args: ['install', 'jira.js@^6.2.0', '@scope/agent@^0.84.1'], cwd: project });
  });

  it('starts nothing when every package is installed', () => {
    const root = fakePackage(path.join(tempFolder(), 'clone'));
    addPackage(path.join(root, 'node_modules'), 'jira.js');
    addPackage(path.join(root, 'node_modules'), '@scope/agent');
    const { run, calls } = recorder();

    expect(installMissingDependencies({ root, run, nodeMajor: 22 })).toEqual({ kind: 'present' });
    expect(calls).toEqual([]);
  });

  it('reports a failure when npm fails, and when npm succeeds but a package is still missing', () => {
    const root = fakePackage(path.join(tempFolder(), 'clone'));

    expect(installMissingDependencies({ root, run: recorder(() => 1).run, nodeMajor: 22 }).kind).toBe('failed');
    expect(installMissingDependencies({ root, run: recorder(() => 0).run, nodeMajor: 22 }).kind).toBe('failed');
  });

  it('reports a failure when the install removed the package folder of light-plan', () => {
    // `npm install` in a project removes a package that the project does not list.
    const root = fakePackage(path.join(tempFolder(), 'project', 'node_modules', 'light-plan'));
    const { run } = recorder(() => {
      rmSync(root, { recursive: true, force: true });
      return 0;
    });

    expect(installMissingDependencies({ root, run, nodeMajor: 22 }).kind).toBe('failed');
  });

  it('starts nothing on a Node that the packages do not support, and says what to run', () => {
    const root = fakePackage(path.join(tempFolder(), 'clone'));
    const { run, calls } = recorder();

    const outcome = installMissingDependencies({ root, run, nodeMajor: 20 });

    expect(calls).toEqual([]);
    expect(outcome).toMatchObject({
      kind: 'skipped',
      reason: 'The experimental packages need Node 22 or newer, and this is Node 20.',
      command: 'npm install --no-save "jira.js@^6.2.0" "@scope/agent@^0.84.1"',
    });
  });

  it('starts nothing in an npx cache, and says what to run', () => {
    const root = fakePackage(path.join(tempFolder(), '_npx', 'abc123', 'node_modules', 'light-plan'));
    const { run, calls } = recorder();

    const outcome = installMissingDependencies({ root, run, nodeMajor: 22 });

    expect(calls.filter((call) => call.args[0] === 'install')).toEqual([]);
    expect(outcome.kind).toBe('skipped');
    expect(installCommandLine(installTarget(root, null), experimentalDependencies(root))).toBe(
      'npm install "jira.js@^6.2.0" "@scope/agent@^0.84.1"',
    );
  });
});
