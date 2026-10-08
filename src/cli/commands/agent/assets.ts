import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { BoardError } from '../../../core/index.js';

/**
 * The files this package ships — a neutral tree that no harness uses directly:
 *
 *   assets/
 *     agents/<name>.md        markdown with portable frontmatter
 *     skills/<name>.md
 *     <anything>/...          any file at all: scripts, JSON, templates
 *     harnesses/<name>.yml    where all of the above lands, per harness
 *
 * **Nothing here knows what an "agent" or a "skill" is.** This walks the tree
 * and reads frontmatter where a file has some; the harness mappings select what
 * to copy with `.gitignore`-style patterns and say where it goes. Adding a new
 * kind of asset is a file, not a code change.
 *
 * `assets/` is resolved relative to this file's depth, the same way
 * `operations/init.ts` finds its templates, so it works from `src/` and `dist/`.
 * Moving this file breaks `lpm agent`.
 */

export type Role = 'developer' | 'pm';
export const ROLES: Role[] = ['developer', 'pm'];

/**
 * Reserved names under `assets/`: the mappings themselves (per harness, and
 * per hcm bundle) and the note explaining the tree. Everything else is payload, so `from: "**"` copies what
 * a person means by it.
 */
export const RESERVED = ['harnesses', 'hcm', 'README.md'];

export interface AssetFile {
  /** Path relative to `assets/`, forward slashes: `agents/lpm-developer.md`. */
  relativePath: string;
  /** Absolute path on disk. */
  file: string;
  /** First path segment, kept because it reads well in reports: `agents`. */
  kind: string;
  /** Basename without its extension: `lpm-developer`. */
  name: string;
  /** Basename with its extension. */
  basename: string;
  /** Extension without the dot, or '' when there is none. */
  ext: string;
  /** Parsed frontmatter, when the file has any. */
  front: Frontmatter | null;
}

export interface Frontmatter {
  name?: string;
  description?: string;
  roles?: Role[];
  tools?: string[];
  /** The body after the frontmatter block. */
  body: string;
}

export function assetsDir(): string {
  // <package>/dist/cli/commands/agent/assets.js -> <package>/assets
  return fileURLToPath(new URL('../../../../assets', import.meta.url));
}

/**
 * Read frontmatter if the file starts with a `---` block. Returns null for
 * anything else, which is how a script or a JSON file passes through untouched.
 */
export function readFrontmatter(file: string): Frontmatter | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) return null;

  let front: Record<string, unknown>;
  try {
    front = (YAML.parse(match[1]!) ?? {}) as Record<string, unknown>;
  } catch (error) {
    throw new BoardError(`${file} has frontmatter that is not valid YAML`, [
      (error as Error).message,
    ]);
  }

  const list = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined;

  return {
    name: typeof front.name === 'string' ? front.name : undefined,
    description: typeof front.description === 'string' ? front.description : undefined,
    roles: list(front.roles)?.filter((role): role is Role => ROLES.includes(role as Role)),
    tools: list(front.tools),
    body: match[2]!,
  };
}

function walk(root: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (RESERVED.includes(relative)) continue;
    if (entry.isDirectory()) found.push(...walk(root, relative));
    else found.push(relative);
  }
  return found;
}

/** Every shippable file under `assets/`, with its frontmatter where it has any. */
export function loadAssetFiles(): AssetFile[] {
  const root = assetsDir();
  let relatives: string[];
  try {
    relatives = walk(root);
  } catch (error) {
    throw new BoardError(`Cannot read the bundled assets in ${root}`, [
      (error as Error).message,
      'This package looks incomplete; reinstall light-plan.',
    ]);
  }

  return relatives.map((relativePath) => {
    const file = path.join(root, ...relativePath.split('/'));
    const basename = path.basename(relativePath);
    const ext = path.extname(basename);
    const front = readFrontmatter(file);

    if (front?.name && front.name !== basename.slice(0, basename.length - ext.length)) {
      throw new BoardError(`${file} declares name "${front.name}"`, [
        "An asset's name has to match its file name.",
      ]);
    }

    return {
      relativePath,
      file,
      kind: relativePath.split('/')[0]!,
      name: basename.slice(0, basename.length - ext.length),
      basename,
      ext: ext.replace(/^\./, ''),
      front,
    };
  });
}

/**
 * Does this file belong to one of the roles asked for? A file that declares no
 * roles belongs to all of them — a shared script or template is not somebody's
 * private business.
 */
export function inRoles(asset: AssetFile, roles: Role[]): boolean {
  const declared = asset.front?.roles;
  return !declared?.length || declared.some((role) => roles.includes(role));
}
