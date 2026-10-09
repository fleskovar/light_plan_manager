import { parseArgs } from 'node:util';
import type { TypeDef } from '../../core/index.js';
import {
  BoardError,
  createIssue,
  createPeriod,
  createResource,
  createSquad,
  displayPath,
  hasSquads,
  isGenericType,
  kindOfType,
  parseAttributeInput,
} from '../../core/index.js';
import { requireBoard } from '../context.js';
import { bold, dim, green, out } from '../ui.js';

export const help = `Create an issue, a period or a resource, pre-populated from its config template.

Usage
  lpm new <type> [title] [options]

The type name decides what gets created: issue types live under .lpm/board,
period types (sprints, increments) under .lpm/timeline, and resource types
(people, pools) under .lpm/team.

Options (all)
  -t, --title <text>       Title (or pass it as the second argument)
  -n, --name <text>        Alias for --title
  -p, --parent <id>        Create inside this issue / period / resource
      --set key=value      Set an attribute; repeatable

Options (issues)
  -s, --status <id>        Starting status (default: the board's default_status)
      --period <id>        Schedule the issue in a period (default: the board's
                           default_period while it is the whole timeline;
                           "none" leaves the issue unscheduled)
      --assignee <id>      Assign to a person or a pool, by id or name
      --depends-on <ids>   Issues this one is blocked by; comma-separated, repeatable
      --relates-to <ids>   Non-blocking associations
      --related <path>     A file this issue is about; repeatable. A path from
                           the project root, optionally with a line range
                           (docs/prd.md#L10-L42)

Options (periods)
      --starts <date>      Inclusive start, YYYY-MM-DD (required)
      --ends <date>        Inclusive end, YYYY-MM-DD (required)

Options (resources)
      --capacity <n>       Full-time equivalents: 1 a person, 0.5 part-time,
                           3 a pool of three (default: 1)
      --covers <ids>       Pools this resource can be drawn from

Options (squads)
      --members <ids>      Resource ids for this squad, comma-separated

Examples
  lpm new epic -t "Checkout revamp" -p LP-1
  lpm new user_story -t "Guest checkout" -p LP-3 --set story_points=3 --assignee alice
  lpm new sprint -t "Sprint 1" --starts 2026-08-03 --ends 2026-08-14 -p TL-1
  lpm new person -t "Alice Smith" --set email=alice@example.com --covers RS-7
  lpm new role -t "Jr. software developer" --capacity 3
  lpm new squad -t "Frontend"`;

function idList(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((entry) => entry.split(',')).map((id) => id.trim()).filter(Boolean);
}

function parseSets(typeDef: TypeDef, type: string, sets: string[] | undefined): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const entry of sets ?? []) {
    const split = entry.indexOf('=');
    if (split < 1) {
      throw new BoardError(`Invalid --set "${entry}"`, ['Expected the form key=value.']);
    }
    const key = entry.slice(0, split).trim();
    const def = typeDef.attributes[key];
    if (!def) {
      throw new BoardError(`"${key}" is not an attribute of "${type}"`, [
        `Declared attributes: ${Object.keys(typeDef.attributes).join(', ') || '(none)'}`,
      ]);
    }
    const parsed = parseAttributeInput(def, entry.slice(split + 1));
    if (parsed.error) throw new BoardError(`--set ${key}: ${parsed.error}`);
    attributes[key] = parsed.value;
  }
  return attributes;
}

function reject(condition: boolean, message: string, detail: string): void {
  if (condition) throw new BoardError(message, [detail]);
}

export function run(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      title: { type: 'string', short: 't' },
      name: { type: 'string', short: 'n' },
      parent: { type: 'string', short: 'p' },
      status: { type: 'string', short: 's' },
      period: { type: 'string' },
      assignee: { type: 'string' },
      starts: { type: 'string' },
      ends: { type: 'string' },
      capacity: { type: 'string' },
      covers: { type: 'string', multiple: true },
      'depends-on': { type: 'string', multiple: true },
      'relates-to': { type: 'string', multiple: true },
      // Not comma-split like the id lists: a path may legitimately contain one.
      related: { type: 'string', multiple: true },
      set: { type: 'string', multiple: true },
      members: { type: 'string' },
    },
  });

  const type = positionals[0];
  if (!type) throw new BoardError('Missing type', ['Usage: lpm new <type> -t "Title"']);

  const title = values.title ?? values.name ?? positionals[1];
  if (!title) throw new BoardError('Missing title', [`Usage: lpm new ${type} -t "Title"`]);

  const board = requireBoard();
  const kind = kindOfType(board.config, type);
  if (!kind) {
    const periodTypes = Object.keys(board.config.period_types).join(', ');
    const resourceTypes = Object.keys(board.config.resource_types).join(', ');
    const squadTypes = Object.keys(board.config.squad_types).join(', ');
    throw new BoardError(`Unknown type "${type}"`, [
      `Issue types: ${Object.keys(board.config.issue_types).join(', ')}`,
      ...(periodTypes ? [`Period types: ${periodTypes}`] : []),
      ...(resourceTypes ? [`Resource types: ${resourceTypes}`] : []),
      ...(squadTypes ? [`Squad types: ${squadTypes}`] : []),
    ]);
  }

  const rosterOnly = values.capacity !== undefined || idList(values.covers).length > 0;
  const dependsOn = idList(values['depends-on']);
  const relatesTo = idList(values['relates-to']);
  const relatedFiles = (values.related ?? []).map((ref) => ref.trim()).filter(Boolean);
  const issueLinks =
    dependsOn.length > 0 || relatesTo.length > 0 || relatedFiles.length > 0;

  if (kind === 'resource') {
    const typeDef = board.config.resource_types[type]!;
    reject(values.status !== undefined, '--status does not apply to resources', 'People and pools have no board column.');
    reject(values.period !== undefined, '--period does not apply to resources', 'Resources are not scheduled; issues are.');
    reject(values.assignee !== undefined, '--assignee does not apply to resources', 'Assign issues to resources, not the other way round.');
    reject(
      values.starts !== undefined || values.ends !== undefined,
      '--starts and --ends apply to periods only',
      'A resource is available until you say otherwise.',
    );
    reject(
      issueLinks,
      'Links apply to issues only',
      'Use --covers to say which pools a resource can be drawn from.',
    );

    const capacity = values.capacity === undefined ? undefined : Number(values.capacity);
    if (capacity !== undefined && !Number.isFinite(capacity)) {
      throw new BoardError(`Invalid --capacity "${values.capacity}"`, ['Expected a number, e.g. 1, 0.5 or 3.']);
    }

    const resource = createResource(board, {
      type,
      title,
      capacity,
      covers: idList(values.covers),
      parentId: values.parent,
      attributes: parseSets(typeDef, type, values.set),
    });

    const kindLabel = isGenericType(board.config, type) ? 'pool' : 'person';
    out(`${green('Created')} ${bold(resource.id)}  ${dim(typeDef.label)}  ${resource.title}`);
    out(`  ${dim(`${kindLabel}, ${resource.capacity} FTE`)}`);
    if (resource.covers.length) out(`  ${dim(`covers ${resource.covers.join(', ')}`)}`);
    out(`  ${dim(displayPath(board.paths, resource.file))}`);
    return 0;
  }

  reject(rosterOnly, '--capacity and --covers apply to resources only', 'They describe who can do the work, not the work.');

  if (kind === 'period') {
    const typeDef = board.config.period_types[type]!;
    reject(values.status !== undefined, '--status does not apply to periods', 'Periods are timeboxes, not board columns.');
    reject(values.period !== undefined, '--period does not apply to periods', 'Use --parent to nest a period inside another.');
    reject(values.assignee !== undefined, '--assignee does not apply to periods', 'Assign the issues inside the period instead.');
    reject(
      issueLinks,
      'Links apply to issues only',
      'Only issues can depend on or relate to each other.',
    );
    if (!values.starts || !values.ends) {
      throw new BoardError('A period needs --starts and --ends', [
        `Example: lpm new ${type} -t "${title}" --starts 2026-08-03 --ends 2026-08-14`,
      ]);
    }

    const period = createPeriod(board, {
      type,
      title,
      starts: values.starts,
      ends: values.ends,
      parentId: values.parent,
      attributes: parseSets(typeDef, type, values.set),
    });

    out(`${green('Created')} ${bold(period.id)}  ${dim(typeDef.label)}  ${period.title}`);
    out(`  ${dim(`${period.starts} .. ${period.ends}`)}`);
    out(`  ${dim(displayPath(board.paths, period.file))}`);
    return 0;
  }

  if (kind === 'squad') {
    const typeDef = board.config.squad_types[type]!;
    reject(values.status !== undefined, '--status does not apply to squads', 'Squads are groups of resources.');
    reject(values.period !== undefined, '--period does not apply to squads', 'Assign squads to a period with lpm set <period> --squad <id>.');
    reject(values.assignee !== undefined, '--assignee does not apply to squads', 'Assign issues to resources, not squads.');
    reject(
      values.starts !== undefined || values.ends !== undefined,
      '--starts and --ends apply to periods only',
      'Squads are a team grouping, not a timebox.',
    );
    reject(issueLinks, 'Links apply to issues only', 'Squads carry members, not dependencies.');
    reject(rosterOnly, '--capacity and --covers apply to resources only', 'Squads group resources; set capacity on the resources themselves.');

    const squad = createSquad(board, {
      type,
      title,
      members: values.members ? idList([values.members]) : undefined,
      attributes: parseSets(typeDef, type, values.set),
    });

    out(`${green('Created')} ${bold(squad.id)}  ${dim(typeDef.label)}  ${squad.title}`);
    if (squad.members.length) out(`  ${dim(`members ${squad.members.join(', ')}`)}`);
    out(`  ${dim(displayPath(board.paths, squad.file))}`);
    return 0;
  }

  const typeDef = board.config.issue_types[type]!;
  reject(
    values.starts !== undefined || values.ends !== undefined,
    '--starts and --ends apply to periods only',
    'Schedule an issue with --period <id> instead.',
  );

  const issue = createIssue(board, {
    type,
    title,
    status: values.status,
    parentId: values.parent,
    period: values.period === 'none' ? null : values.period,
    assignee: values.assignee,
    dependsOn,
    relatesTo,
    relatedFiles,
    attributes: parseSets(typeDef, type, values.set),
  });

  out(`${green('Created')} ${bold(issue.id)}  ${dim(typeDef.label)}  ${issue.title}`);
  if (issue.assignee) out(`  ${dim(`assigned to ${issue.assignee}`)}`);
  if (issue.period) out(`  ${dim(`scheduled in ${issue.period}`)}`);
  if (issue.depends_on.length) out(`  ${dim(`depends on ${issue.depends_on.join(', ')}`)}`);
  if (issue.related_files.length) out(`  ${dim(`files ${issue.related_files.join(', ')}`)}`);
  out(`  ${dim(displayPath(board.paths, issue.file))}`);
  return 0;
}
