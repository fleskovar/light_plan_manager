import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { BoardError } from '../../../core/index.js';
import type { AssetFile } from '../agent/assets.js';
import { ROLES, assetsDir, loadAssetFiles } from '../agent/assets.js';
import { installFile, pointerBlock } from '../agent/install.js';
import { placementsFor, ruleSchema } from '../agent/mapping.js';
import { launchCommand } from '../mcp/config.js';

/**
 * hcm bundles, rendered from `assets/` rather than kept beside it.
 *
 * `assets/` is the only copy of the agents and skills. An hcm bundle is one
 * more layout of that tree — `subagents/`, `skills/<name>/SKILL.md`, a manifest
 * — so each `assets/hcm/<name>.yml` is a list of the same copy rules a harness
 * mapping holds, plus the manifest fields only a person can choose. What is not
 * a choice is filled in here: the version is the package's, so a bundle can
 * never claim to be a release it is not.
 *
 * The bundles land in a folder this tool owns (`defaultBundleDir`), never in
 * the package itself: `hcm update` reads the registered folder again, and a
 * package run through `npx` lives in a cache npm clears whenever it likes.
 */

const bundleSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'must be lower-kebab-case'),
    description: z.string().min(1),
    tags: z.array(z.string()).default([]),
    /** hcm flavor name -> description. */
    flavors: z.record(z.string(), z.string()).default({}),
    /** Write the pointer block as `context/<name>.md`. */
    context: z.string().regex(/^\d\d-[a-z0-9-]+$/, 'must look like 10-name').optional(),
    /** Write the `lpm mcp` entry as `mcp/<name>.json`. */
    mcp: z.string().regex(/^[a-z][a-z0-9-]*$/, 'must be lower-kebab-case').optional(),
    files: z.array(ruleSchema).min(1),
  })
  .strict();

export type Bundle = z.infer<typeof bundleSchema>;

function bundlesDir(): string {
  return path.join(assetsDir(), 'hcm');
}

export function parseBundleText(text: string, expected: string, where = expected): Bundle {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (error) {
    throw new BoardError(`${where} is not valid YAML`, [(error as Error).message]);
  }
  const parsed = bundleSchema.safeParse(doc);
  if (!parsed.success) {
    throw new BoardError(
      `${where} is not a valid hcm bundle mapping`,
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  if (parsed.data.name !== expected) {
    throw new BoardError(`${where} declares name "${parsed.data.name}"`, [
      "A bundle's name has to match its file name.",
    ]);
  }
  return parsed.data;
}

/** Every bundle this package ships, in file order. */
export function loadBundles(): Bundle[] {
  const dir = bundlesDir();
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.yml')).sort();
  } catch (error) {
    throw new BoardError(`Cannot read the hcm bundles in ${dir}`, [
      (error as Error).message,
      'This package looks incomplete; reinstall light-plan.',
    ]);
  }
  return names.map((name) => {
    const file = path.join(dir, name);
    return parseBundleText(readFileSync(file, 'utf8'), path.basename(name, '.yml'), file);
  });
}

interface PackageInfo {
  version: string;
  author?: string;
  homepage?: string;
}

function packageInfo(): PackageInfo {
  const file = path.join(assetsDir(), '..', 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as Partial<PackageInfo>;
  if (!pkg.version) throw new BoardError(`${file} has no version`);
  return { version: pkg.version, author: pkg.author, homepage: pkg.homepage };
}

/**
 * Where the bundles live between `lpm hcm init` and the next `hcm update`: the
 * platform's per-user data folder, which nothing clears behind our back.
 */
export function defaultBundleDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const base =
    platform === 'win32'
      ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(base, 'light-plan', 'hcm');
}

/** Does every flavor install this asset? Only those belong in shared context. */
function inEveryRole(asset: AssetFile): boolean {
  const roles = asset.front?.roles;
  return !roles?.length || ROLES.every((role) => roles.includes(role));
}

export interface Rendered {
  name: string;
  version: string;
  dir: string;
  files: number;
}

/**
 * Write one bundle into `<dir>/<name>`, replacing what an earlier render left
 * there so a file deleted from `assets/` leaves the bundle too. A folder that
 * holds something other than a bundle is refused rather than emptied.
 */
function renderBundle(bundle: Bundle, dir: string, assets: AssetFile[], onPath: boolean): Rendered {
  const target = path.join(dir, bundle.name);
  if (existsSync(target) && readdirSync(target).length && !existsSync(path.join(target, 'hcm.yaml'))) {
    throw new BoardError(`${target} is not empty and holds no hcm bundle`, [
      'Pass --dir with a folder light-plan may write its bundles into.',
    ]);
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  const placing = {
    harness: { name: `hcm/${bundle.name}`, files: bundle.files },
    scope: 'project' as const,
    vars: { project: target, home: homedir(), root: target },
  };
  const { placements, empty } = placementsFor(placing, assets, [...ROLES]);
  if (empty.length) {
    throw new BoardError(`assets/hcm/${bundle.name}.yml has a rule that matches nothing`, [
      ...empty.map((rule) => `from: ${rule.from.join(', ')}`),
    ]);
  }
  for (const placement of placements) installFile(placement, { force: true, dryRun: false });

  const pkg = packageInfo();
  const manifest = {
    name: bundle.name,
    version: pkg.version,
    description: bundle.description,
    ...(pkg.author ? { author: pkg.author } : {}),
    ...(pkg.homepage ? { homepage: pkg.homepage } : {}),
    ...(bundle.tags.length ? { tags: bundle.tags } : {}),
    ...(Object.keys(bundle.flavors).length ? { flavors: bundle.flavors } : {}),
  };
  const header =
    '# Rendered by `lpm hcm init` from the light-plan package. Do not edit:\n' +
    "# change the package's assets/ and run the command again.\n";
  writeFileSync(path.join(target, 'hcm.yaml'), header + YAML.stringify(manifest, { lineWidth: 0 }));
  let files = placements.length + 1;

  if (bundle.context) {
    const shared = placements.map((placement) => placement.asset).filter(inEveryRole);
    mkdirSync(path.join(target, 'context'), { recursive: true });
    writeFileSync(path.join(target, 'context', `${bundle.context}.md`), `${pointerBlock(shared)}\n`);
    files += 1;
  }
  if (bundle.mcp) {
    mkdirSync(path.join(target, 'mcp'), { recursive: true });
    writeFileSync(
      path.join(target, 'mcp', `${bundle.mcp}.json`),
      `${JSON.stringify(launchCommand(onPath), null, 2)}\n`,
    );
    files += 1;
  }

  return { name: bundle.name, version: pkg.version, dir: target, files };
}

/**
 * Render every bundle into `dir`, which becomes an hcm *collection*: one
 * `hcm registry add <dir>` registers each bundle in it under its own name.
 * `onPath` decides how the MCP entry starts `lpm` (see `launchCommand`).
 */
export function renderBundles(dir: string, options: { onPath: boolean }): Rendered[] {
  const assets = loadAssetFiles();
  return loadBundles().map((bundle) => renderBundle(bundle, dir, assets, options.onPath));
}
