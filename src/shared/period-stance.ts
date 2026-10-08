/**
 * Where a period stands, once the switch and the calendar have both been read.
 *
 * The single definition that the engine (`src/core/board/query.ts`) and the
 * browser (`web/src/lib/board/periods.ts`) both call — so the canvas and
 * `lpm task next` cannot disagree about what is now. The two callers adapt
 * their own data shapes to the minimal structural interface declared here;
 * neither imports anything from the other.
 *
 * See docs/periods.md for the full reference.
 */

/**
 * Where a period stands once the switch and the calendar have both been read.
 * `auto` is the ordinary answer and means nobody has held the switch.
 */
export type PeriodStance = 'on' | 'off' | 'auto';

/** The minimal shape `periodStance` needs from a period document. */
export interface PeriodNode {
  id: string;
  parentId: string | null;
  active?: boolean | null;
}

/**
 * The switch as it applies to one period.
 *
 * The two directions are deliberately not symmetric. Switching a period **off**
 * is a statement about everything inside it — parking an increment parks the
 * sprints in it, or "not this quarter" would mean nothing. Switching one **on**
 * is a statement about that timebox alone, because a quarter being live has
 * never meant all six of its sprints are this week.
 */
export function periodStance(
  node: PeriodNode,
  getParent: (id: string) => PeriodNode | undefined,
): PeriodStance {
  const seen = new Set<string>();
  let current: PeriodNode | undefined = node;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.active === false) return 'off';
    current = current.parentId ? getParent(current.parentId) : undefined;
  }
  return node.active === true ? 'on' : 'auto';
}

/** Whether `today` falls inside a period's dates. An open end runs on. */
export function periodHoldsDate(
  dated: { starts?: string | null; ends?: string | null },
  today: string,
): boolean {
  if (!dated.starts) return false;
  if (dated.starts > today) return false;
  return !dated.ends || dated.ends >= today;
}

/**
 * Is this period running today? The switch when somebody has held it, the dates
 * otherwise.
 */
export function isPeriodRunning(
  node: PeriodNode,
  getParent: (id: string) => PeriodNode | undefined,
  today: string,
  dated: { starts?: string | null; ends?: string | null },
): boolean {
  const stance = periodStance(node, getParent);
  if (stance !== 'auto') return stance === 'on';
  return periodHoldsDate(dated, today);
}
