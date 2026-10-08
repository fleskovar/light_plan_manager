import type { ConfigDto, IssueDto, NodeDto } from '$shared';
import { priorityRank } from '$lib/board/selectors.js';

/** Which column the rows are sorted by. */
export type SortColumn = 'title' | 'type' | 'status' | 'assignee' | 'period' | string;

export type SortDir = 'asc' | 'desc';

const byTitle = (a: NodeDto, b: NodeDto): number =>
  a.title.localeCompare(b.title);

const byType = (a: NodeDto, b: NodeDto): number =>
  a.type.localeCompare(b.type);

function issue(a: NodeDto): IssueDto | null {
  return a.kind === 'issue' ? (a as IssueDto) : null;
}

function mkByStatus(config: ConfigDto): (a: NodeDto, b: NodeDto) => number {
  return (a: NodeDto, b: NodeDto): number => {
    const ia = issue(a);
    const ib = issue(b);
    if (!ia && !ib) return 0;
    if (!ia) return -1;
    if (!ib) return 1;
    const st = config.statuses.findIndex((s) => s.id === ia.status);
    const sb = config.statuses.findIndex((s) => s.id === ib.status);
    const ra = st === -1 ? Infinity : st;
    const rb = sb === -1 ? Infinity : sb;
    return ra - rb || ia.title.localeCompare(ib.title);
  };
}

function mkByAssignee(nodes: Record<string, NodeDto>): (a: NodeDto, b: NodeDto) => number {
  return (a: NodeDto, b: NodeDto): number => {
    const ia = issue(a);
    const ib = issue(b);
    const na = ia?.assignee ? nodes[ia.assignee]?.title ?? ia.assignee : '';
    const nb = ib?.assignee ? nodes[ib.assignee]?.title ?? ib.assignee : '';
    if (!na && !nb) return 0;
    if (!na) return 1;
    if (!nb) return -1;
    return na.localeCompare(nb) || ia!.title.localeCompare(ib!.title);
  };
}

function mkByPeriod(nodes: Record<string, NodeDto>): (a: NodeDto, b: NodeDto) => number {
  return (a: NodeDto, b: NodeDto): number => {
    const ia = issue(a);
    const ib = issue(b);
    const na = ia?.period ? nodes[ia.period]?.title ?? ia.period : '';
    const nb = ib?.period ? nodes[ib.period]?.title ?? ib.period : '';
    if (!na && !nb) return 0;
    if (!na) return 1;
    if (!nb) return -1;
    return na.localeCompare(nb) || ia!.title.localeCompare(ib!.title);
  };
}

function mkByAttribute(column: string, config: ConfigDto): (a: NodeDto, b: NodeDto) => number {
  const isPriority = column === config.priorityAttribute;

  return (a: NodeDto, b: NodeDto): number => {
    const ia = issue(a);
    const ib = issue(b);
    if (!ia && !ib) return 0;
    if (!ia) return -1;
    if (!ib) return 1;

    if (isPriority) {
      return priorityRank(config, ia) - priorityRank(config, ib) ||
        ia.title.localeCompare(ib.title);
    }

    const va = ia.attributes[column];
    const vb = ib.attributes[column];

    if (typeof va === 'number' && typeof vb === 'number') {
      return va - vb || ia.title.localeCompare(ib.title);
    }
    if (typeof va === 'string' && typeof vb === 'string') {
      return va.localeCompare(vb) || ia.title.localeCompare(ib.title);
    }
    if (va === undefined || va === null) return 1;
    if (vb === undefined || vb === null) return -1;

    return ia.title.localeCompare(ib.title);
  };
}

function comparatorFor(
  column: SortColumn,
  config: ConfigDto,
  nodes: Record<string, NodeDto>,
): (a: NodeDto, b: NodeDto) => number {
  switch (column) {
    case 'title':   return byTitle;
    case 'type':    return byType;
    case 'status':  return mkByStatus(config);
    case 'assignee': return mkByAssignee(nodes);
    case 'period':  return mkByPeriod(nodes);
    default:        return mkByAttribute(column, config);
  }
}

/**
 * A sort comparator that preserves hierarchy: it is always applied within each
 * parent's children list, so rows stay grouped under their parent. Callers pass
 * it to `buildRows` the same way `byTitle` was used.
 */
export function columnComparator(
  column: SortColumn,
  dir: SortDir,
  config: ConfigDto,
  nodes: Record<string, NodeDto>,
): (a: NodeDto, b: NodeDto) => number {
  const cmp = comparatorFor(column, config, nodes);
  if (dir === 'desc') return (a, b) => -cmp(a, b);
  return cmp;
}
