/**
 * Jira sprints (LP-328) — the period container, pure half.
 *
 * Jira's native period container is a **sprint**, and sprints belong to an
 * *Agile board*, not a project — so reading and writing them goes through the
 * Agile API (`/rest/agile/1.0/…`), a separate base path from the v3 issue API.
 * This module is the pure part: the sprint model, the page parser, the name
 * lookup and the two facts that gate a write (a closed sprint refuses work, a
 * missing sprint is a provision request rather than a silent no-op).
 *
 * The network half lives in `connector.ts` (`sprints()`, `createSprint`, the
 * sprint field read/write on create/update/get/list). The translator's period
 * push/pull uses `PeriodContainer` / `mapPeriodFromRemote` from
 * `../../periods.ts` exactly as GitHub's milestone carrier does — the sprint
 * carrier is a third `PeriodCarrier`, and the join is by sprint *name*.
 */

import type { JiraField } from './fields.js';

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** One sprint as the Agile API returns it (`GET /board/{boardId}/sprint`). */
export interface JiraSprint {
  /** The sprint's numeric id, e.g. `37`. */
  id: string;
  /** The sprint name, e.g. "Sprint 1" — what a period title matches. */
  name: string;
  /** The sprint state: `future`, `active` or `closed`. */
  state: string;
  /** `startDate`, `YYYY-MM-DD`, when the sprint carries one. */
  starts?: string;
  /** `endDate`, `YYYY-MM-DD`, when the sprint carries one. */
  ends?: string;
  /** `completeDate`, an ISO timestamp, when the sprint was closed. */
  completeDate?: string;
}

/**
 * The custom-field *type key* that identifies Jira's built-in sprint field.
 * The field's per-instance id (`customfield_10020`) is discovered from the
 * instance's field list, never hard-coded — exactly as `mapping.attributes`
 * resolves names to ids (LP-327).
 */
export const SPRINT_FIELD_TYPE = 'com.pyxis.greenhopper.jira:gh-sprint';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** A sprint date as `YYYY-MM-DD`, from a string or a Date the client coerced. */
function dateOnly(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return undefined;
}

/** A sprint timestamp as an ISO string, from a string or a Date the client coerced. */
function timestampOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return undefined;
}

/**
 * Parse one Agile API sprint page (`{ values: [...], isLast, startAt }`) into
 * `JiraSprint`s. The board sprint endpoint returns sprints in every state —
 * future, active and closed — which is what lets a push tell a closed sprint
 * from a future one before moving work into it. Dates arrive as strings from
 * the wire but as `Date`s after jira.js validates them, so both spellings are
 * read.
 */
export function parseSprints(raw: unknown): JiraSprint[] {
  if (raw === null || typeof raw !== 'object') return [];
  const record = raw as Record<string, unknown>;
  const values = record['values'];
  if (!Array.isArray(values)) return [];

  const out: JiraSprint[] = [];
  for (const entry of values) {
    if (entry === null || typeof entry !== 'object') continue;
    const sprint = entry as Record<string, unknown>;
    const id = sprint['id'];
    const name = sprint['name'];
    if ((typeof id !== 'string' && typeof id !== 'number') || typeof name !== 'string') continue;
    const state = sprint['state'];
    out.push({
      id: String(id),
      name,
      state: typeof state === 'string' ? state : '',
      ...(dateOnly(sprint['startDate']) !== undefined ? { starts: dateOnly(sprint['startDate']) } : {}),
      ...(dateOnly(sprint['endDate']) !== undefined ? { ends: dateOnly(sprint['endDate']) } : {}),
      ...(timestampOf(sprint['completeDate']) !== undefined
        ? { completeDate: timestampOf(sprint['completeDate']) }
        : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The two facts a write needs
// ---------------------------------------------------------------------------

/** True when the sprint is `closed` — the one state work must never move into. */
export function isClosedSprint(sprint: JiraSprint): boolean {
  return sprint.state.trim().toLowerCase() === 'closed';
}

/** The sprint whose name matches, or `undefined` when the board has none. */
export function sprintByName(
  sprints: readonly JiraSprint[],
  name: string,
): JiraSprint | undefined {
  return sprints.find((sprint) => sprint.name === name);
}

/** The desired sprints that have no match among the board's existing sprints,
 * in board order — what a push creates before it files. Idempotent by
 * construction: re-running against an updated sprint list creates nothing. */
export function missingSprints(
  desired: readonly { name: string; starts?: string; ends?: string }[],
  existing: readonly JiraSprint[],
): Array<{ name: string; starts?: string; ends?: string }> {
  const names = new Set(existing.map((sprint) => sprint.name));
  return desired.filter((entry) => !names.has(entry.name));
}

/** The sprint custom field's per-instance id, or `undefined` when the instance
 * has no sprint field (which is itself the honest answer for "sprints are not
 * enabled here"). */
export function sprintFieldIdOf(
  fields: readonly Pick<JiraField, 'id' | 'customType'>[],
): string | undefined {
  const field = fields.find((entry) => entry.customType === SPRINT_FIELD_TYPE);
  return field?.id;
}

// ---------------------------------------------------------------------------
// The connector surface (provision, LP-328)
// ---------------------------------------------------------------------------

/** The sprint operations the live Jira connector exposes, for `lpm remote
 * provision` and the translator's push/pull. Absent on a fake that does not
 * model sprints. */
export interface JiraSprintConnector {
  readonly name: string;
  /** Every sprint on the configured Agile board, in every state. */
  listSprints?(signal?: AbortSignal): Promise<JiraSprint[]>;
  /** Create a future sprint on the configured Agile board, returning its id. */
  createSprint?(
    name: string,
    starts?: string,
    ends?: string,
    signal?: AbortSignal,
  ): Promise<{ id: string }>;
}
