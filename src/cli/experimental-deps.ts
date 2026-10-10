import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The packages that the experimental features load, and installing the ones
 * that are missing.
 *
 * The experimental features load three packages with a dynamic `import`:
 * `jira.js` (the Jira provider), and `@earendil-works/pi-coding-agent` and
 * `@earendil-works/pi-ai` (`lpm queue agent`). `package.json` declares them as
 * optional peer dependencies, so `npm install light-plan` does not install
 * them. `lpm experimental on` does, through the functions below.
 *
 * **The list is read from `package.json`.** A package is experimental when it
 * is a peer dependency that `peerDependenciesMeta` marks optional. A fourth
 * optional peer is installed with no edit here.
 *
 * **Where npm installs depends on where light-plan is.** Node resolves an
 * `import` from the folder of the importing file upward, so a package must
 * land where light-plan finds it. `installTarget` reads that from the folder
 * of this package:
 *
 * | The package folder is | Kind | The npm command |
 * | --- | --- | --- |
 * | in the global `node_modules` (`npm root -g`) | `global` | `npm install -g <packages>` |
 * | in the `node_modules` of a project | `project` | `npm install <packages>`, run in the project |
 * | not in a `node_modules` folder (a clone, or `npm link`) | `checkout` | `npm install --no-save <packages>`, run in the clone |
 * | in an `npx` cache, or under `.pnpm` or `.yarn` | `manual` | none: this module prints what to run |
 *
 * Every function takes the package folder and the runner of `npm` as
 * arguments, so the tests use a folder of their own and never start `npm`.
 */

/** The folder of the light-plan package: two levels above `dist/cli/` and `src/cli/`. */
export function packageRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url));
}

export interface ExperimentalDependency {
  name: string;
  /** The version range that `package.json` declares, for example `^6.2.0`. */
  range: string;
  installed: boolean;
}

/**
 * True when Node resolves the package `name` from the folder `from`. The walk
 * is the one that Node does for a bare specifier: `node_modules/<name>` in the
 * folder and in each folder above it.
 */
export function isInstalled(name: string, from: string): boolean {
  let dir = path.resolve(from);
  for (;;) {
    const modules = path.basename(dir) === 'node_modules' ? dir : path.join(dir, 'node_modules');
    if (existsSync(path.join(modules, name, 'package.json'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** The optional peer dependencies of the package in `root`, each with whether it is installed. */
export function experimentalDependencies(root: string = packageRoot()): ExperimentalDependency[] {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  return Object.entries(pkg.peerDependencies ?? {})
    .filter(([name]) => pkg.peerDependenciesMeta?.[name]?.optional === true)
    .map(([name, range]) => ({ name, range, installed: isInstalled(name, root) }));
}

export type InstallKind = 'global' | 'project' | 'checkout' | 'manual';

export interface InstallTarget {
  kind: InstallKind;
  /** The folder that `npm` runs in. */
  cwd: string;
  /** The arguments of `npm` that come before the package names. Empty for `manual`. */
  args: string[];
}

const samePath = (a: string, b: string): boolean => {
  const real = (target: string): string => {
    try {
      return realpathSync(target);
    } catch {
      return path.resolve(target);
    }
  };
  const [left, right] = [real(a), real(b)];
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};

/**
 * Where and how `npm` installs a package that light-plan in `root` can load.
 * `globalRoot` is the answer of `npm root -g`, or null when npm did not answer.
 */
export function installTarget(root: string, globalRoot: string | null): InstallTarget {
  const folder = path.resolve(root);
  const parent = path.dirname(folder);
  const segments = folder.split(path.sep);

  // An npx cache is deleted by npm, and pnpm and yarn own their own folders.
  if (segments.some((segment) => segment === '_npx' || segment === '.pnpm' || segment === '.yarn')) {
    return { kind: 'manual', cwd: folder, args: [] };
  }
  if (path.basename(parent) !== 'node_modules') {
    return { kind: 'checkout', cwd: folder, args: ['install', '--no-save'] };
  }
  if (globalRoot !== null && samePath(parent, globalRoot)) {
    return { kind: 'global', cwd: folder, args: ['install', '-g'] };
  }
  return { kind: 'project', cwd: path.dirname(parent), args: ['install'] };
}

/** `name@range` for each package, as `npm install` takes it. */
export function installSpecs(dependencies: ExperimentalDependency[]): string[] {
  return dependencies.map((dependency) => `${dependency.name}@${dependency.range}`);
}

/** The command as a person types it, for a message. */
export function installCommandLine(target: InstallTarget, dependencies: ExperimentalDependency[]): string {
  const args = target.kind === 'manual' ? ['install'] : target.args;
  return ['npm', ...args, ...installSpecs(dependencies).map((spec) => `"${spec}"`)].join(' ');
}

/** Runs `npm` with arguments in a folder. Returns the exit status, or null when npm did not start. */
export type NpmRunner = (args: string[], cwd: string, capture: boolean) => { status: number | null; stdout: string };

/**
 * Run npm. On Windows npm is `npm.cmd`, which Node starts only through a
 * shell, and a shell splits at spaces and reads `^` as an escape. So each
 * argument is quoted and the line is handed over whole, as `lpm hcm` does.
 */
export const runNpm: NpmRunner = (args, cwd, capture) => {
  const settings = { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' } as const;
  const result =
    process.platform === 'win32'
      ? spawnSync(['npm', ...args.map((arg) => `"${arg}"`)].join(' '), { ...settings, shell: true })
      : spawnSync('npm', args, settings);
  return { status: result.error ? null : result.status, stdout: String(result.stdout ?? '') };
};

/** The global `node_modules` folder of npm, or null when npm does not answer. */
export function npmGlobalRoot(run: NpmRunner = runNpm, cwd: string = process.cwd()): string | null {
  const result = run(['root', '-g'], cwd, true);
  const answer = result.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? '';
  return result.status === 0 && answer ? answer : null;
}

/** The lowest Node version that the experimental packages run on. `jira.js` needs 22, the pi agent 22.19. */
export const EXPERIMENTAL_NODE_MAJOR = 22;

export type InstallOutcome =
  /** Every package was there already. */
  | { kind: 'present' }
  | { kind: 'installed'; packages: string[]; command: string }
  /** npm ran and failed, or did not start. */
  | { kind: 'failed'; packages: string[]; command: string }
  /** Nothing was run, and `reason` says why. `command` is what the person runs. */
  | { kind: 'skipped'; packages: string[]; command: string; reason: string };

export interface InstallOptions {
  root?: string;
  run?: NpmRunner;
  /** The major version of Node. A test passes one. */
  nodeMajor?: number;
}

/**
 * Install each experimental package that is missing. Does nothing when every
 * package is installed, so it is safe to call on every `lpm experimental on`.
 */
export function installMissingDependencies(options: InstallOptions = {}): InstallOutcome {
  const root = options.root ?? packageRoot();
  const run = options.run ?? runNpm;
  const nodeMajor = options.nodeMajor ?? Number(process.versions.node.split('.')[0]);

  const missing = experimentalDependencies(root).filter((dependency) => !dependency.installed);
  if (!missing.length) return { kind: 'present' };
  const packages = missing.map((dependency) => dependency.name);

  const inNodeModules = path.basename(path.dirname(path.resolve(root))) === 'node_modules';
  const target = installTarget(root, inNodeModules ? npmGlobalRoot(run, root) : null);
  const command = installCommandLine(target, missing);

  if (nodeMajor < EXPERIMENTAL_NODE_MAJOR) {
    return {
      kind: 'skipped',
      packages,
      command,
      reason: `The experimental packages need Node ${EXPERIMENTAL_NODE_MAJOR} or newer, and this is Node ${nodeMajor}.`,
    };
  }
  if (target.kind === 'manual') {
    return {
      kind: 'skipped',
      packages,
      command,
      reason:
        'light-plan runs from an npx cache or from a folder that pnpm or yarn manages, so npm cannot add a package beside it.',
    };
  }

  const result = run([...target.args, ...installSpecs(missing)], target.cwd, false);
  // The exit status of npm is not enough: the question is whether Node now
  // finds each package from this folder. The read can also throw, because
  // `npm install` in a project removes a package that the project's
  // package.json does not list, and that package can be light-plan itself.
  let stillMissing = true;
  try {
    stillMissing = experimentalDependencies(root).some((dependency) => !dependency.installed);
  } catch {
    stillMissing = true;
  }
  return result.status === 0 && !stillMissing
    ? { kind: 'installed', packages, command }
    : { kind: 'failed', packages, command };
}
