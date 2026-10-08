import path from 'node:path';
import { parseArgs } from 'node:util';
import { BoardError, findBoardPaths } from '../../../core/index.js';
import { bold, cyan, dim, green, out, plural, yellow } from '../../ui.js';
import { DEFAULT_SERVER_NAME, buildEntry, lpmOnPath } from '../mcp/config.js';
import type { AssetFile, Role } from './assets.js';
import { ROLES, inRoles, loadAssetFiles } from './assets.js';
import type { Action, InstallOptions } from './install.js';
import { installFile, installMcp, installPointer, pointerBlock } from './install.js';
import type { Harness, Scope } from './mapping.js';
import {
  findHarness,
  harnessNames,
  loadHarnesses,
  mcpFor,
  placementsFor,
  pointerFor,
  resolve,
} from './mapping.js';
import { choose } from '../../prompt.js';

/**
 * `lpm agent` installs the assets this package ships into somebody else's
 * project, rearranged for whichever harness they use.
 *
 * The assets are a neutral tree (`assets.ts`) and the layouts are data
 * (`assets/harnesses/*.yml`, read by `mapping.ts`), so this file never mentions
 * a harness by name. Adding one is a YAML file; adding an asset kind is a
 * directory. See `docs/harness-layouts.md`.
 */
export const help = `Install the light-plan agents, skills and MCP config into a project.

Usage
  lpm agent --target <harness> [--type <role>] [options]

Options
      --target <name>   Which harness to install for   (required)
      --type <role>     developer | pm | all          (default: all; repeatable)
      --project         Install into a project (default: the working directory)
      --global          Install for this user, for every project
      --dir <path>      The project to install into (implies --project)
      --name <name>     Name for the MCP server entry (default: ${DEFAULT_SERVER_NAME})
      --user <id|name>  Make the agent act as this team member
      --profile <path>  Point the agent at a profile (see \`lpm profile\`)
      --read-only       Give the agent only the MCP tools that do not write
      --no-mcp          Install the markdown only, leaving MCP config alone
      --force           Replace files and entries that are already there
      --dry-run         Say what would happen, write nothing
      --list            Show the harnesses and assets this package ships

Roles
  developer  Picks work up, implements it, and leaves a reviewable trail
  pm         Writes epics, features and stories, and sequences them

Where things land is declared per harness in assets/harnesses/*.yml: a list of
copy rules, each selecting source files with .gitignore-style patterns. Any file
under assets/ can go anywhere — markdown gets the frontmatter the host wants,
anything else is copied byte for byte. Run --list to see the rules, and read
docs/harness-layouts.md for the schema.

Nothing is destroyed: existing directories are added to, an existing MCP config
is merged into with its other keys untouched, and a markdown file the harness
owns gets a delimited block that is replaced in place on the next run. A file
this command wrote before is only overwritten with --force.

Without --project or --global you are asked which you want.

Examples
  lpm agent --list
  lpm agent --target claude
  lpm agent --target copilot --type developer --dir ../our-service
  lpm agent --target claude --type pm --user "Planner Bot" --name planner
  lpm agent --target reasonix --global
  lpm agent --target claude --dry-run`;

interface Values {
  target?: string;
  type?: string[];
  project?: boolean;
  global?: boolean;
  dir?: string;
  name?: string;
  user?: string;
  profile?: string;
  'read-only'?: boolean;
  'no-mcp'?: boolean;
  force?: boolean;
  'dry-run'?: boolean;
  list?: boolean;
}

function rolesFrom(values: Values): Role[] {
  const raw = (values.type ?? [])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!raw.length) return [...ROLES];

  const wanted = new Set<Role>();
  for (const value of raw) {
    if (value === 'all' || value === 'both') {
      for (const role of ROLES) wanted.add(role);
    } else if ((ROLES as string[]).includes(value)) {
      wanted.add(value as Role);
    } else {
      throw new BoardError(`Unknown --type "${value}"`, [
        `Expected one of: ${ROLES.join(', ')}, all.`,
      ]);
    }
  }
  return [...wanted];
}

function harnessFrom(values: Values): Harness {
  if (!values.target) {
    throw new BoardError('Pass --target', [
      `Expected one of: ${harnessNames().join(', ')}.`,
      'Run `lpm agent --list` for what each one writes.',
    ]);
  }
  const harness = findHarness(values.target);
  if (!harness) {
    throw new BoardError(`Unknown --target "${values.target}"`, [
      `Expected one of: ${harnessNames().join(', ')}.`,
    ]);
  }
  return harness;
}

function scopeFrom(values: Values): Scope {
  if (values.project && values.global) {
    throw new BoardError('Pass one of --project and --global');
  }
  if (values.global) return 'user';
  if (values.project || values.dir) return 'project';

  return choose<Scope>(
    'Install for this project, or for your user account?',
    [
      {
        value: 'project',
        label: 'This project',
        detail: 'Committed with the repository, so the whole team gets it.',
      },
      {
        value: 'user',
        label: 'My user account',
        detail: 'Available in every project on this machine, and shared with nobody.',
      },
    ],
    '--project or --global',
  );
}

/** `--list`: what this package ships, and where each harness puts it. */
function runList(): number {
  const assets = loadAssetFiles();

  out(bold('Files'));
  for (const asset of assets) {
    const roles = asset.front?.roles?.length ? asset.front.roles.join(', ') : 'all roles';
    out(`  ${asset.relativePath.padEnd(34)}${dim(roles)}`);
  }

  out();
  out(bold('Harnesses'));
  for (const harness of loadHarnesses()) {
    out(`  ${harness.name}  ${dim(harness.label)}`);
    for (const rule of harness.files) {
      const scope = rule.scope ? dim(` [${rule.scope} only]`) : '';
      const mode = rule.frontmatter ? '' : dim('  (verbatim)');
      out(`    ${rule.from.join(', ')}`);
      out(`      ${dim('->')} ${rule.to}${scope}${mode}`);
    }

    // A file nothing selects would ship and never arrive; say so here rather
    // than leaving someone to notice it missing.
    const placed = new Set(
      placementsFor(resolve(harness, 'project', process.cwd()), assets, [...ROLES]).placements.map(
        (placement) => placement.asset.relativePath,
      ),
    );
    const missed = assets.filter((asset) => !placed.has(asset.relativePath));
    if (missed.length) {
      out(`    ${yellow(`no rule matches: ${missed.map((a) => a.relativePath).join(', ')}`)}`);
    }
    if (harness.docs) out(`    ${dim(harness.docs)}`);
  }

  out();
  out(dim('Layouts are declared in assets/harnesses/*.yml — see docs/harness-layouts.md'));
  return 0;
}

function report(actions: Action[], root: string): void {
  const shown = (file: string): string => {
    const relative = path.relative(root, file);
    return relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : file;
  };
  for (const action of actions) {
    const mark =
      action.outcome === 'created'
        ? green('+')
        : action.outcome === 'updated'
          ? cyan('~')
          : action.outcome === 'unchanged'
            ? dim('=')
            : yellow('!');
    out(`  ${mark} ${shown(action.file)}${action.reason ? dim(`  ${action.reason}`) : ''}`);
  }
}

export function run(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      target: { type: 'string' },
      type: { type: 'string', multiple: true },
      project: { type: 'boolean' },
      global: { type: 'boolean' },
      dir: { type: 'string' },
      name: { type: 'string' },
      user: { type: 'string' },
      profile: { type: 'string' },
      'read-only': { type: 'boolean' },
      'no-mcp': { type: 'boolean' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      list: { type: 'boolean' },
    },
  }) as { values: Values };

  if (values.list) return runList();

  const harness = harnessFrom(values);
  const roles = rolesFrom(values);
  const scope = scopeFrom(values);
  const project = path.resolve(values.dir ?? process.cwd());

  const assets = loadAssetFiles().filter((asset) => inRoles(asset, roles));
  if (!assets.length) throw new BoardError(`Nothing to install for --type ${roles.join(', ')}`);

  const resolved = resolve(harness, scope, project);
  const options: InstallOptions = {
    force: values.force === true,
    dryRun: values['dry-run'] === true,
  };

  out(
    `${bold(values['dry-run'] ? 'Would install' : 'Installing')} ${harness.label} assets ` +
      `${dim(`(${roles.join(' + ')})`)}`,
  );
  out(`  ${dim(scope === 'project' ? `project  ${project}` : `user     ${resolved.root}`)}`);
  out();

  const { placements, empty } = placementsFor(resolved, assets, roles);
  const actions: Action[] = [];
  const placed: AssetFile[] = [];

  for (const placement of placements) {
    actions.push(installFile(placement, options));
    placed.push(placement.asset);
  }

  // A file no rule selects would ship and never arrive, and a rule that selects
  // nothing is nearly always a typo. Both are reported, neither is fatal.
  const unplaced = assets.filter(
    (asset) => !placed.some((entry) => entry.relativePath === asset.relativePath),
  );

  // The MCP entry is what makes the board reachable at all; the markdown only
  // explains it. A project with no board still gets one, pointed at itself.
  let advice: string | null = null;
  if (!values['no-mcp']) {
    const board = scope === 'project' ? findBoardPaths(project) : null;
    const entry = buildEntry({
      onPath: lpmOnPath(),
      root: board?.root ?? project,
      user: values.user,
      profile: values.profile,
      readOnly: values['read-only'] === true,
    });
    // A user-wide entry must not pin one project's directory.
    if (scope === 'user') delete entry.cwd;

    const mcp = mcpFor(resolved);
    const action = installMcp(
      mcp.file,
      values.name ?? DEFAULT_SERVER_NAME,
      entry,
      mcp.key,
      options,
    );
    if (action) actions.push(action);
    else if (mcp.advice) advice = mcp.advice;
  }

  const pointer = pointerFor(resolved);
  if (pointer) actions.push(installPointer(pointer, pointerBlock(placed), options));

  report(actions, scope === 'project' ? project : resolved.root);

  const wrote = actions.filter(
    (action) => action.outcome === 'created' || action.outcome === 'updated',
  );
  const skipped = actions.filter((action) => action.outcome === 'skipped');
  out();
  out(
    values['dry-run']
      ? dim(`${plural(wrote.length, 'file')} would change, ${skipped.length} skipped`)
      : `${green('Done')} ${plural(wrote.length, 'file')} written, ${skipped.length} skipped`,
  );

  if (skipped.length && !values.force) {
    out(dim('  Pass --force to replace what is already there.'));
  }
  if (unplaced.length) {
    out();
    out(
      `${yellow('  note')} no rule in ${harness.name}.yml matches ` +
        `${unplaced.map((asset) => asset.relativePath).join(', ')}; not installed.`,
    );
    out(`  ${dim(`Add a rule to assets/harnesses/${harness.name}.yml.`)}`);
  }
  if (empty.length) {
    out();
    for (const rule of empty) {
      out(`${yellow('  note')} "${rule.from.join(', ')}" matched no files.`);
    }
  }
  if (advice) {
    out();
    out(`${yellow('  todo')} this target keeps user-level MCP servers somewhere we will not rewrite.`);
    for (const line of advice.trimEnd().split('\n')) out(`  ${dim(line)}`);
  }
  if (harness.note) {
    out();
    out(`${yellow('  note')} ${harness.note}`);
  }

  if (scope === 'project' && !findBoardPaths(project)) {
    out();
    out(`${yellow('  warn')} no .lpm board found in ${project}`);
    out(`  ${dim('The agents have nothing to work on until you run')} ${cyan('lpm init')}`);
  }

  out();
  out(dim('Restart your agent host to pick the new assets up.'));
  return 0;
}
