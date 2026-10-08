/**
 * Drag-and-drop parsing for period columns.
 *
 * The two data types on the transfer list — `application/x-lpm-period` for
 * reordering and `application/x-lpm-issue` for scheduling — are read once here
 * so the component can ask "what does this drop mean?" instead of parsing the
 * transfer list itself.
 *
 * Because `periodDropAt` lives beside the component emitting `data-period-drop`
 * (a pointer drag has no drop targets of its own), this module lives beside the
 * component rather than in `$lib`.  It is unit-testable without DOM.
 */

/** What a drag event over a period column resolves to. */
export type DropIntent =
  | { kind: 'schedule'; issueId: string }
  | { kind: 'reorder'; periodId: string }
  | { kind: 'none' };

/**
 * Parse the drop intent from a DragEvent's dataTransfer.
 *
 * Period data takes precedence: dropping a period on a period is a reorder.
 * An issue is a schedule.  Nothing on the transfer list is a no-op.
 */
export function readDropIntent(event: DragEvent): DropIntent {
  const periodId = event.dataTransfer?.getData('application/x-lpm-period');
  if (periodId) return { kind: 'reorder', periodId };
  const issueId = event.dataTransfer?.getData('application/x-lpm-issue');
  if (issueId) return { kind: 'schedule', issueId };
  return { kind: 'none' };
}
