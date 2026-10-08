import { parseArgs } from 'node:util';
import type { LoadRow, LoadedBoard } from '../../core/index.js';
import { BoardError, currentUser, hasResources, resourceLoad } from '../../core/index.js';
import { requireBoard } from '../context.js';
import { bold, cyan, dim, out, pad, yellow } from '../ui.js';

export const help = `Show the team roster and how much work each resource is carrying.

Usage
  lpm team [options]

Options
      --period <id>   Only count issues scheduled in this period (and its children)
      --open          Hide resources with no open work

Named resources are people; generic ones are pools ("a jr. software
developer") that anyone covering them can pick from. Capacity is full-time
equivalents, so a pool of three reads as 3. Only work units are counted --
parents aggregate their children, they do not add work of their own, and an
issue whose type is "atomic" answers for everything nested inside it.

This is a load view, not a scheduler: it reports demand against declared
capacity and flags pools nobody can serve. Add people with
\`lpm new <resource type> -t "Name"\` and coverage with \`lpm link <id> --covers <pool>\`.

Examples
  lpm team
  lpm team --period TL-2`;

function effortLabel(board: LoadedBoard): string {
  return board.config.effort_attribute;
}

function rowLine(board: LoadedBoard, row: LoadRow, showEffort: boolean): string {
  const id = row.resource ? row.resource.id : '--';
  const title = row.resource ? row.resource.title : '(unassigned)';
  const kind = row.resource ? (row.generic ? 'pool' : 'person') : '';
  const capacity = row.resource ? `${row.capacity} FTE` : '';

  const counts = [`open ${row.open}`, `wip ${row.wip}`, `done ${row.done}`].join('  ');
  const effort = showEffort && row.effort !== null ? `  ${effortLabel(board)} ${row.effort}` : '';

  const coverage = row.resource
    ? row.generic
      ? row.coveredBy.length
        ? dim(`covered by ${row.coveredBy.join(', ')}`)
        : // Only a problem once there is work stuck in the pool.
          (row.open ? yellow : dim)('nobody covers this')
      : row.covers.length
        ? dim(`covers ${row.covers.join(', ')}`)
        : ''
    : '';

  return `  ${bold(pad(id, 8))}${pad(title, 28)}${dim(pad(kind, 8))}${dim(pad(capacity, 9))}${dim(counts)}${dim(effort)}  ${coverage}`.trimEnd();
}

export function run(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { period: { type: 'string' }, open: { type: 'boolean' } },
  });

  const board = requireBoard();
  if (!hasResources(board.config)) {
    throw new BoardError('This board has no team roster', [
      'Add resource_types, resource_hierarchy and resource_prefix to .lpm/config.yml.',
    ]);
  }

  const report = resourceLoad(board, { periodId: values.period });
  if (values.period && !report.period) throw new BoardError(`No period with id "${values.period}"`);

  const showEffort = Boolean(board.config.effort_attribute);
  const scope = report.period ? ` in ${report.period.id} (${report.period.title})` : '';
  const people = report.rows.filter((row) => !row.generic);
  const pools = report.rows.filter((row) => row.generic);
  const visible = (row: LoadRow) => !values.open || row.open > 0;

  out(`${bold('Roster')}${dim(scope)}`);
  if (!report.rows.length) {
    out(dim('  nobody on the roster yet'));
    out(`${dim('  add someone with')} ${cyan('lpm new <resource type> -t "Name"')}`);
    return 0;
  }

  for (const row of people.filter(visible)) out(rowLine(board, row, showEffort));
  if (pools.length) {
    out();
    out(`${bold('Pools')}`);
    for (const row of pools.filter(visible)) out(rowLine(board, row, showEffort));
  }
  if (report.unassigned.open || report.unassigned.done) {
    out();
    out(rowLine(board, report.unassigned, showEffort));
  }

  out();
  const totals = [
    `${report.totals.capacity} FTE`,
    `${report.totals.open} open`,
    `${report.totals.wip} in progress`,
  ];
  if (report.totals.effort !== null) {
    totals.push(`${report.totals.effort} ${effortLabel(board)}`);
    if (report.totals.capacity > 0) {
      const perFte = report.totals.effort / report.totals.capacity;
      totals.push(`${perFte.toFixed(1)} per FTE`);
    }
  }
  out(`${bold('Total')}  ${dim(totals.join('  ·  '))}`);

  if (report.uncovered.length) {
    out();
    for (const pool of report.uncovered) {
      out(`${yellow('warn')} ${pool.id} (${pool.title}) holds open work but nobody covers it`);
    }
  }
  if (report.unassigned.open) {
    out(`${yellow('warn')} ${report.unassigned.open} open issue(s) have no assignee`);
  }

  const user = currentUser(board);
  if (!user) out(`${dim('Set who you are with')} ${cyan('lpm me <id or name>')}`);
  return 0;
}
