import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  installTarget,
  npmGlobalRoot,
  packageRoot,
  runNpm,
  type InstallTarget,
  type NpmRunner,
} from './experimental-deps.js';

/**
 * Upgrading the installed light-plan to the latest version on the npm
 * registry, for `lpm upgrade`.
 *
 * `upgradeLightPlan` asks npm for the version that the tag `latest` names
 * (`npm view light-plan version`). It compares that version with the version
 * in the `package.json` of the running package. When the registry holds a
 * newer version, it runs the npm command that matches the install:
 *
 * | `installTarget` returns | The npm command |
 * | --- | --- |
 * | `global` | `npm install -g light-plan@<latest>` |
 * | `project` | `npm install light-plan@<latest>`, run in the project |
 * | `checkout` (a clone, or `npm link`) | none: npm does not manage the folder |
 * | `manual` (an npx cache, pnpm or yarn) | none: npm does not manage the folder |
 *
 * Every function takes the package folder and the npm runner as arguments,
 * so the tests use a folder of their own and never start npm.
 */

export const PACKAGE_NAME = 'light-plan';

/** The `version` in the `package.json` of the package in `root`, or null when the file has none. */
export function installedVersion(root: string = packageRoot()): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Compare two versions of the form `major.minor.patch[-prerelease]`. Returns a
 * negative number when `a` is older, 0 when both are equal and a positive
 * number when `a` is newer. A prerelease is older than the release with the
 * same three numbers. Two prereleases of the same release compare as text.
 */
export function compareVersions(a: string, b: string): number {
  const split = (version: string): { core: number[]; pre: string } => {
    const [core = '', ...pre] = version.trim().replace(/^v/, '').split('-');
    return { core: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre: pre.join('-') };
  };
  const left = split(a);
  const right = split(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** The version that the tag `latest` names on the registry, or null when npm did not answer. */
export function latestVersion(run: NpmRunner, cwd: string): string | null {
  const result = run(['view', PACKAGE_NAME, 'version'], cwd, true);
  const answer = result.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? '';
  return result.status === 0 && /^\d+\.\d+\.\d+/.test(answer) ? answer : null;
}

/**
 * The folder that npm runs in. For a global install, `installTarget` returns
 * the package folder. `npm install -g light-plan` renames that folder, and
 * Windows refuses to rename the working folder of a process (`EBUSY`). So a
 * global upgrade runs in the folder above the global `node_modules`.
 */
export function npmFolder(target: InstallTarget, root: string): string {
  return target.kind === 'global' ? path.dirname(path.dirname(path.resolve(root))) : target.cwd;
}

/** The arguments of `npm` that install `version` for a `global` or `project` target. */
export function upgradeArgs(target: InstallTarget, version: string): string[] {
  return [...target.args, `${PACKAGE_NAME}@${version}`];
}

/** The command as a person types it, for a message. */
export function upgradeCommandLine(target: InstallTarget, version = 'latest'): string {
  if (target.kind === 'checkout') return 'git pull && npm install && npm run build';
  if (target.kind === 'manual') {
    return target.cwd.split(path.sep).includes('_npx')
      ? `npx ${PACKAGE_NAME}@latest <command>`
      : `the upgrade command of the package manager that installed ${PACKAGE_NAME}`;
  }
  return ['npm', ...upgradeArgs(target, version)].join(' ');
}

export type UpgradeOutcome =
  /** The installed version equals the version on the registry. */
  | { kind: 'current'; installed: string; latest: string }
  /** The installed version is newer than the version on the registry. */
  | { kind: 'ahead'; installed: string; latest: string }
  /** `check` was set, and the registry holds a newer version. Nothing was run. */
  | { kind: 'available'; installed: string; latest: string; command: string }
  | { kind: 'upgraded'; from: string; to: string; command: string }
  /** npm ran and failed, or the package folder does not hold the new version afterwards. */
  | { kind: 'failed'; installed: string; latest: string; command: string }
  /** npm did not return the version on the registry. */
  | { kind: 'unreachable'; installed: string }
  /** npm does not manage the folder that light-plan runs from. Nothing was run. */
  | {
      kind: 'unmanaged';
      installed: string;
      latest: string | null;
      install: 'checkout' | 'manual';
      folder: string;
      command: string;
    };

export interface UpgradeOptions {
  root?: string;
  run?: NpmRunner;
  /** True: report the versions and run no install. */
  check?: boolean;
}

/** Upgrade light-plan to the version that the tag `latest` names, or report why it did not. */
export function upgradeLightPlan(options: UpgradeOptions = {}): UpgradeOutcome {
  const root = options.root ?? packageRoot();
  const run = options.run ?? runNpm;
  const installed = installedVersion(root) ?? '0.0.0';

  const inNodeModules = path.basename(path.dirname(path.resolve(root))) === 'node_modules';
  const target = installTarget(root, inNodeModules ? npmGlobalRoot(run, root) : null);
  const cwd = npmFolder(target, root);
  const latest = latestVersion(run, cwd);

  if (target.kind === 'checkout' || target.kind === 'manual') {
    return {
      kind: 'unmanaged',
      installed,
      latest,
      install: target.kind,
      folder: path.resolve(root),
      command: upgradeCommandLine(target),
    };
  }
  if (latest === null) return { kind: 'unreachable', installed };

  const order = compareVersions(installed, latest);
  if (order === 0) return { kind: 'current', installed, latest };
  if (order > 0) return { kind: 'ahead', installed, latest };

  const command = upgradeCommandLine(target, latest);
  if (options.check) return { kind: 'available', installed, latest, command };

  const result = run(upgradeArgs(target, latest), cwd, false);
  // The exit status of npm is not enough. The package folder must hold the
  // new version afterwards.
  const after = installedVersion(root);
  return result.status === 0 && after === latest
    ? { kind: 'upgraded', from: installed, to: latest, command }
    : { kind: 'failed', installed, latest, command };
}
