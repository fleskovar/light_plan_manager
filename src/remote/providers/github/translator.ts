/**
 * GitHub's two-way vocabulary translation.
 *
 * GitHub has no native issue types, no custom fields, and no workflow state
 * beyond open/closed — so everything the board distinguishes rides on labels.
 * This translator is the GitHub-specific bridge between the board vocabulary
 * and the GitHub one, using the remote's `mapping` block:
 *
 *   push: a `BoardOp` plus the mapping becomes a `RemoteRequest` carrying
 *         title, body and the labels that stand in for type / status /
 *         attributes;
 *   pull: a GitHub issue record plus the mapping becomes `BoardFieldsPatch`,
 *         recovering type and status from labels when the mapping names them
 *         unambiguously.
 *
 * Pure: no I/O. One translator serves every GitHub remote; the mapping and the
 * board's attribute definitions are passed per call. Where a value cannot be
 * mapped back unambiguously, the field is left absent rather than guessed —
 * the pull planner, which sees the whole board and its hierarchy, is the layer
 * that breaks ties (LP-268).
 *
 * Statuses are the one vocabulary element that is fully two-way here: the
 * status engine (`mapping.ts`, LP-269) resolves a board status to the remote
 * label a push writes, resolves the observed labels back to a board status,
 * and carries the `closed` flag that maps a terminal status onto GitHub's
 * open/closed state.
 *
 * Attributes go through the coercion engine (`attributes.ts`, LP-270): a value
 * is coerced to its label form on the way out and back to its board type on
 * the way in, with a reported failure when it cannot — an enum value with no
 * matching option, a number field holding free text. On this provider the
 * remote field kind is derived from the board type, because GitHub's only
 * carrier is a label: an `array` attribute claims one label per item, every
 * other type claims one label holding the value as text. A label the mapping
 * does not claim is never read into an attribute, and is left for the executor
 * to preserve — labels are shared with humans.
 *
 * Assignees go through the account mapping (`accounts.ts`, LP-271): a person
 * whose `via` attribute holds a login becomes that login, a person with no
 * login and a generic pool both go unassigned — the pool also carries a
 * `pool:` label so the pull can restore it — and a login nobody on the roster
 * matches is reported with the `lpm new person` that would add them, never
 * invented.
 *
 * Periods go through the period mapping (`periods.ts`, LP-272, LP-313): the
 * mapped level becomes the native carrier — a milestone or a Project iteration
 * field — and every other level a `period:<type>` row in the managed block.
 * The pull resolves the carrier's title back to a local period — recovering
 * the dates for the planner to reconcile — and reads the degraded levels back
 * out of the block.
 */

import type { AttributeDef } from '../../../core/model/types.js';
import {
  mapAssigneeFromRemote,
  mapAssigneeToRemote,
  normalizeAccountMapping,
  type ResourceGap,
  type Roster,
  type UnknownAccount,
} from '../../accounts.js';
import {
  coerceFromRemote,
  coerceToRemote,
  type AttributeProblem,
  type RemoteField,
} from '../../attributes.js';
import type {
  AttributeDefs,
  BoardFieldsPatch,
  BoardOp,
  DescribeResult,
  FieldsFromRecordResult,
  RemoteRecord,
  RemoteRequest,
  Translator,
} from '../../provider.js';
import {
  boardTypesMatching,
  claimedTypeValues,
  isClosedRemote,
  mapStatusFromRemote,
  mapStatusToRemote,
  mapTypeToRemote,
} from '../../mapping.js';
import { parseManagedBlock } from '../../managed-block.js';
import { labelClaim, type LabelClaim } from '../../labels.js';
import { withBlockAssignee } from '../../accounts.js';
import {
  degradedFromBlockFields,
  degradedTypesOf,
  mapPeriodFromRemote,
  mapPeriodToRemote,
  normalizePeriodMapping,
  type DegradedPeriod,
  type PeriodContainer,
  type PeriodGap,
  type PeriodIndex,
} from '../../periods.js';
import {
  projectStatusFieldOf,
  resolveProjectStatus,
} from './project-status.js';
import type { GithubMapping } from './config.js';

/** Extract a GitHub issue's labels as plain strings. */
function labelsOf(record: RemoteRecord): string[] {
  const labels = record.labels;
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === 'string') return label;
      if (label && typeof label === 'object') {
        const name = (label as { name?: unknown }).name;
        if (typeof name === 'string') return name;
      }
      return '';
    })
    .filter((label) => label.length > 0);
}

/**
 * The remote field a board attribute of this type lands on, given that the
 * only carrier GitHub has is a label. An `array` claims one label per item
 * (`labels`); every other type claims a single label holding the value as text
 * (`text`). The coercion then does the type work in both directions.
 */
function fieldFor(type: AttributeDef['type']): RemoteField {
  return type === 'array' ? { kind: 'labels' } : { kind: 'text' };
}

/** Skip a value that carries nothing to write. */
function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * The labels a mapping claims, derived from its declaration (LP-308). Exact
 * labels are the type labels and status states; prefixes are the attribute
 * prefixes and the reserved `pool:` prefix (a pool assignment degrades to a
 * label even when no account mapping is declared). Degraded period levels no
 * longer ride labels — they ride the managed block (LP-313) — so the claim
 * derives nothing from the timeline. Derived from the mapping rather than a
 * convention, so a board that maps an attribute onto real label names still
 * owns exactly those names and nothing else.
 */
export function labelClaimFromMapping(
  mapping: GithubMapping,
  _periods: PeriodIndex = new Map(),
): LabelClaim {
  const exact: string[] = [];
  const prefixes: string[] = [];

  exact.push(...claimedTypeValues(mapping.types ?? {}));
  for (const entry of Object.values(mapping.statuses ?? {})) {
    exact.push(...entry.remote);
  }
  for (const prefix of Object.values(mapping.attributes ?? {})) {
    if (prefix.length > 0) prefixes.push(`${prefix}:`);
  }
  // A generic pool degrades to a `pool:` label whatever the account mapping
  // says, so the prefix is always claimed (LP-271).
  prefixes.push('pool:');

  return labelClaim(exact, prefixes);
}

/**
 * Push: turn a board op into a GitHub request description.
 *
 * A create/update carries `title`, `body` and the labels derived from the
 * mapping: the type's labels, the status's label, and one `<prefix>:<value>`
 * label per mapped attribute (several for an `array`). An attribute value that
 * will not coerce is omitted and reported in `problems` — nothing is written
 * for it. The assignee is resolved through the account mapping (a login, or
 * unassigned for a pool / a gap). A delete carries only its kind — GitHub
 * issues cannot be hard-deleted, so the connector closes them.
 *
 * Every non-delete request also carries the label claim, so the connector can
 * reconcile the list against the labels already on the issue (LP-308).
 */
export function describeRequest(
  op: BoardOp,
  mapping: Record<string, unknown>,
  attributes: AttributeDefs,
  roster: Roster = new Map(),
  periods: PeriodIndex = new Map(),
): DescribeResult {
  if (op.kind === 'delete') {
    return { request: { kind: 'delete' }, problems: [], resourceGaps: [], periodGaps: [] };
  }

  const m = mapping as GithubMapping;
  const labels: string[] = [];
  const problems: AttributeProblem[] = [];
  const resourceGaps: ResourceGap[] = [];
  const periodGaps: PeriodGap[] = [];
  let state: string | undefined;
  let assignee: string | null | undefined;
  let period: PeriodContainer | null | undefined;
  let degradedPeriods: DegradedPeriod[] | undefined;
  let projectStatus: string | undefined;

  // GitHub has no native type field in the REST issue body, so the mapped
  // value rides a label — which carrier it lands in is this translator's
  // call, never the mapping's.
  const remoteType = mapTypeToRemote(m.types ?? {}, op.fields.type);
  if (remoteType !== undefined) labels.push(remoteType);

  const remoteStatus = mapStatusToRemote(m.statuses ?? {}, op.fields.status);
  if (remoteStatus !== undefined) {
    labels.push(remoteStatus);
    // A terminal status closes the remote issue; an explicitly-open status
    // opens it (so a card moved back out of `done` reopens its twin).  When
    // the mapping does not say, the state is left untouched rather than
    // guessed — `lpm check` warns about a terminal status that never says.
    const closed = isClosedRemote(m.statuses ?? {}, op.fields.status);
    if (closed === true) state = 'closed';
    else if (closed === false) state = 'open';

    // Project status (LP-312): when the board's status lives in a Project
    // single-select, the same label is also the column value the connector
    // writes there — the executor asks for it only on a status-affecting
    // write.
    if (projectStatusFieldOf(m) !== undefined) projectStatus = remoteStatus;
  }

  // Assignee: resolve the board resource to a GitHub login (LP-271).  A pool
  // becomes unassigned plus a `pool:` label; a person with no login becomes
  // unassigned and is reported.  Absent (`undefined`) means the op does not
  // carry an assignee, so the remote side is left untouched.
  if (op.fields.assignee !== undefined) {
    const accounts = normalizeAccountMapping(m.accounts);
    const push = mapAssigneeToRemote(roster, accounts, op.fields.assignee);
    labels.push(...push.labels);
    assignee = push.account ?? null;
    if (push.gap) resourceGaps.push(push.gap);
  }

  // Period: resolve the issue's period to a container (the mapped level) plus
  // the degraded levels above it, which ride the managed block (LP-313).
  // Absent (`undefined`) means the op does not carry a period, so the remote
  // side is left untouched; a period at a degraded level has no container and
  // clears the milestone/iteration, its membership riding on the block instead.
  if (op.fields.period !== undefined) {
    const periodMapping = normalizePeriodMapping(m.periods);
    if (periodMapping) {
      const push = mapPeriodToRemote(periods, periodMapping, op.fields.period);
      if (push.degraded.length > 0) degradedPeriods = push.degraded;
      period = push.container ?? null;
      if (push.gap) periodGaps.push(push.gap);
    }
  }

  for (const [attribute, prefix] of Object.entries(m.attributes ?? {})) {
    const value = op.fields.attributes?.[attribute];
    if (isEmptyValue(value)) continue;

    const type = attributes[attribute]?.type ?? 'string';
    const field = fieldFor(type);
    const result = coerceToRemote(type, value, field);
    if (!result.ok) {
      problems.push({ attribute, direction: 'push', reason: result.reason, options: result.options });
      continue;
    }

    if (field.kind === 'labels') {
      for (const item of result.value as string[]) labels.push(`${prefix}:${item}`);
    } else {
      labels.push(`${prefix}:${String(result.value)}`);
    }
  }

  return {
    request: {
      kind: op.kind,
      title: op.fields.title,
      body: op.fields.body,
      labels,
      labelClaim: labelClaimFromMapping(m, periods),
      state,
      assignee,
      period,
      ...(degradedPeriods !== undefined ? { degradedPeriods } : {}),
      ...(projectStatus !== undefined ? { projectStatus } : {}),
    },
    problems,
    resourceGaps,
    periodGaps,
  };
}

/**
 * Pull: turn a GitHub issue record into board fields.
 *
 * `title` and `body` pass through; `type` is recovered when exactly one board
 * type's mapped labels match the issue's labels; `status` when a mapped label
 * names it; `attributes` from `<prefix>:<value>` labels, coerced back to each
 * attribute's board type. A label value that will not coerce back (free text
 * in a number field) is reported in `problems` and the attribute is left
 * alone. Ambiguity leaves the field absent — the pull planner breaks ties with
 * the board's hierarchy. The assignee is recovered through the account
 * mapping: the `pool:` label restores a pool, a login restores a person, an
 * unassigned issue clears it, and a login nobody matches is reported. The
 * period is recovered through the period mapping (LP-272, LP-313): the
 * carrier's title — a milestone or a Project iteration — resolves to a local
 * period, its dates are passed through for the planner to reconcile, a
 * carrier nobody on the timeline matches is reported in `result.period.missing`
 * rather than invented, and the degraded levels ride back out of the managed
 * block.
 */
export function fieldsFromRecord(
  record: RemoteRecord,
  mapping: Record<string, unknown>,
  attributes: AttributeDefs,
  roster: Roster = new Map(),
  periods: PeriodIndex = new Map(),
): FieldsFromRecordResult {
  const m = mapping as GithubMapping;
  const labels = labelsOf(record);
  const patch: BoardFieldsPatch = {};
  const problems: AttributeProblem[] = [];
  const unknownAccounts: UnknownAccount[] = [];
  const result: FieldsFromRecordResult = { patch, problems, unknownAccounts };

  if (typeof record.title === 'string') patch.title = record.title;
  // The managed block is the sync layer's own output, never the document's
  // prose — it is stripped on the way back so the local body holds what a
  // human wrote, not the `parent` / edge / period rows the encoder appended
  // (LP-309, LP-314, LP-313).
  let managedFields: Record<string, string> = {};
  if (typeof record.body === 'string') {
    const parsed = parseManagedBlock(record.body);
    patch.body = parsed.found ? parsed.body : record.body;
    if (parsed.found) managedFields = parsed.fields;
  }

  // Period: the container (a milestone or an iteration, per the carrier)
  // resolves to a local period by name among the mapped level's periods; its
  // dates are the observed dates, carried for the planner to reconcile against
  // the local period.  A container with no local counterpart is reported,
  // never invented (LP-272, LP-313).
  const periodMapping = normalizePeriodMapping(m.periods);
  if (periodMapping) {
    let name: string | undefined;
    let ends: string | undefined;
    if (periodMapping.carrier === 'iteration') {
      // The iteration title arrives on the record via `project_iteration`,
      // enriched by the connector's Project read (LP-313).
      const iteration = record['project_iteration'];
      if (typeof iteration === 'string') name = iteration;
    } else {
      const milestone = record.milestone;
      if (milestone && typeof milestone === 'object') {
        const title = (milestone as { title?: unknown }).title;
        if (typeof title === 'string') name = title;
        const due = (milestone as { due_on?: unknown }).due_on;
        if (typeof due === 'string') ends = due;
      }
    }
    const pull = mapPeriodFromRemote(periods, periodMapping, {
      container: name,
      ends,
      degraded: degradedFromBlockFields(managedFields, degradedTypesOf(periods, periodMapping)),
    });
    if (pull.periodId !== undefined) patch.period = pull.periodId;
    result.period = pull;
  }

  // Assignee: the `pool:` label restores a pool, a login matching a person's
  // `via` value restores that person, an explicitly-unassigned issue clears
  // the local assignee, and a login nobody on the roster matches is reported
  // with the `lpm new person` that would add them — never invented (LP-271).
  const assignee = record.assignee;
  let login: string | undefined;
  if (assignee && typeof assignee === 'object') {
    const value = (assignee as { login?: unknown }).login;
    if (typeof value === 'string') login = value;
  }
  // An assignee the remote could not hold rides the managed block (rung 4), and
  // it is recovered by handing the block's value to the same pool resolution the
  // `pool:` label uses — both carry a board resource id, so one reader serves
  // both and there is no second way for an assignee to come back.
  const accounts = normalizeAccountMapping(m.accounts);
  const resolved = mapAssigneeFromRemote(roster, accounts, {
    account: login,
    labels: withBlockAssignee(labels, managedFields),
  });
  if (resolved.resourceId !== undefined) {
    patch.assignee = resolved.resourceId;
  } else if (resolved.unassigned) {
    patch.assignee = null;
  } else if (resolved.unknown) {
    unknownAccounts.push(resolved.unknown);
  }

  // Type: every board type whose mapped values appear on the issue.
  const typeCandidates = boardTypesMatching(m.types ?? {}, { labels });
  if (typeCandidates.length === 1) patch.type = typeCandidates[0];

  // Status: labels are the legacy carrier; the issue state and (when the
  // mapping declares a Project status field) the Project column are the two
  // signals that can override it. The state only names terminality (a closed
  // issue is the terminal status); the column names a specific status. They
  // resolve together with the configured precedence, and a disagreement is
  // reported in `statusDiscrepancy` rather than silently chosen (LP-312).
  const projectField = projectStatusFieldOf(m);
  const column =
    projectField !== undefined && typeof record['project_status'] === 'string'
      ? record['project_status']
      : undefined;
  const state = typeof record['state'] === 'string' ? record['state'] : undefined;
  const projectResolution = resolveProjectStatus(m, { column, state });

  if (projectResolution.status !== undefined) {
    patch.status = projectResolution.status;
  } else {
    const resolution = mapStatusFromRemote(m.statuses ?? {}, labels);
    if (resolution.status !== undefined) patch.status = resolution.status;
  }
  if (projectResolution.discrepancy !== undefined) {
    result.statusDiscrepancy = projectResolution.discrepancy;
  }

  // Attributes: `<prefix>:<value>` labels, coerced back by prefix and type.
  const recovered: Record<string, unknown> = {};
  for (const [attribute, prefix] of Object.entries(m.attributes ?? {})) {
    const type = attributes[attribute]?.type ?? 'string';
    const field = fieldFor(type);

    if (field.kind === 'labels') {
      const items = labels
        .filter((label) => label.startsWith(`${prefix}:`))
        .map((label) => label.slice(prefix.length + 1))
        .filter((item) => item.length > 0);
      if (items.length > 0) recovered[attribute] = items;
      continue;
    }

    const marker = labels.find((label) => label.startsWith(`${prefix}:`));
    if (marker === undefined) continue;
    const raw = marker.slice(prefix.length + 1);
    const result = coerceFromRemote(type, raw, { values: attributes[attribute]?.values });
    if (result.ok) {
      recovered[attribute] = result.value;
    } else {
      problems.push({ attribute, direction: 'pull', reason: result.reason, options: result.options });
    }
  }
  if (Object.keys(recovered).length > 0) patch.attributes = recovered;

  return result;
}

export const githubTranslator: Translator = {
  describeRequest,
  fieldsFromRecord,
};
