/**
 * Linear's two-way vocabulary translation.
 *
 * Linear has native workflow states, native relations, native cycles and a
 * native assignee — but **no issue types** and **no custom fields** (LP-267).
 * So this translator is a hybrid of the GitHub and Jira ones:
 *
 *   - **type** rides labels, exactly as GitHub's does (rung 3);
 *   - **status** is a native workflow state — the mapping's `statuses.remote`
 *     values are Linear state *names*, written as `state` and read back from
 *     the record's `state.name` (like Jira's native status, without the
 *     transition machinery);
 *   - **attributes** ride label prefixes, exactly as GitHub's do (the ladder
 *     is exercised hardest here — Linear has no custom fields, so a board
 *     attribute beyond the fixed `estimate` / `priority` fields is rung 3);
 *   - **assignee** is the native `assignee`, resolved through the account
 *     mapping (`accounts.ts`, LP-271);
 *   - **period** is a native cycle — the `sprint` carrier (LP-334), resolved
 *     by the connector onto the record as `record.cycle`.
 *
 * The body is Linear's `description`, which is markdown natively — no ADF
 * conversion, unlike Jira.
 *
 * Pure: no I/O. One translator serves every Linear remote; the mapping and the
 * board's attribute definitions are passed per call.
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
  mapStatusFromRemote,
  mapStatusToRemote,
  mapTypeToRemote,
} from '../../mapping.js';
import { parseManagedBlock } from '../../managed-block.js';
import { withBlockAssignee } from '../../accounts.js';
import { labelClaimFromLinearMapping } from './labels.js';
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
import type { LinearMapping } from './config.js';

/** A Linear issue's labels as plain names. */
function labelNamesOf(record: RemoteRecord): string[] {
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

/** A Linear issue's workflow state name, when the record carries one. */
function stateNameOf(record: RemoteRecord): string | undefined {
  const state = record.state;
  if (state && typeof state === 'object') {
    const name = (state as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  if (typeof state === 'string') return state;
  return undefined;
}

/** A Linear issue's cycle name, when the record carries one. */
function cycleNameOf(record: RemoteRecord): string | undefined {
  const cycle = record.cycle;
  if (cycle && typeof cycle === 'object') {
    const name = (cycle as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return undefined;
}

/** The remote field a board attribute of this type lands on, given that the
 * only carrier Linear has for an arbitrary attribute is a label. An `array`
 * claims one label per item; every other type one label holding text. */
function fieldFor(type: AttributeDef['type']): RemoteField {
  return type === 'array' ? { kind: 'labels' } : { kind: 'text' };
}

/** Skip a value that carries nothing to write. */
function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * Push: a board op becomes a Linear request description.
 *
 * A create/update carries `title`, `body` (Linear `description`, markdown) and
 * `labels` — the type's labels plus one `<prefix>:<value>` label per mapped
 * attribute. `state` carries the mapped Linear workflow state name; the
 * connector resolves it to a state id when it writes. The assignee is resolved
 * through the account mapping; the period through the cycle mapping.
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

  const m = mapping as LinearMapping;
  const labels: string[] = [];
  const problems: AttributeProblem[] = [];
  const resourceGaps: ResourceGap[] = [];
  const periodGaps: PeriodGap[] = [];
  let state: string | undefined;
  let assignee: string | null | undefined;
  let estimate: number | null | undefined;
  let period: PeriodContainer | null | undefined;
  let degradedPeriods: DegradedPeriod[] | undefined;

  // Linear has no native issue type, so the mapped value rides a label.
  const remoteType = mapTypeToRemote(m.types ?? {}, op.fields.type);
  if (remoteType !== undefined) labels.push(remoteType);

  const remoteStatus = mapStatusToRemote(m.statuses ?? {}, op.fields.status);
  if (remoteStatus !== undefined) state = remoteStatus;

  // Estimate: the board's effort attribute maps to Linear's native `estimate`
  // (LP-333), not to a label. A finite number is written through; an unset
  // value clears the remote estimate; anything else is reported, never
  // rounded to a legal value (the scale check itself is the preflight's).
  if (m.effort?.attribute !== undefined) {
    const value = op.fields.attributes?.[m.effort.attribute];
    if (typeof value === 'number' && Number.isFinite(value)) {
      estimate = value;
    } else if (isEmptyValue(value)) {
      estimate = null;
    } else {
      problems.push({
        attribute: m.effort.attribute,
        direction: 'push',
        reason: `"${String(value)}" is not a number, so it cannot be an estimate`,
      });
    }
  }

  if (op.fields.assignee !== undefined) {
    const accounts = normalizeAccountMapping(m.accounts);
    const push = mapAssigneeToRemote(roster, accounts, op.fields.assignee);
    labels.push(...push.labels);
    assignee = push.account ?? null;
    if (push.gap) resourceGaps.push(push.gap);
  }

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
    // The effort attribute rides the native `estimate` field (LP-333), never a
    // label — mapping it here too would write the value twice.
    if (attribute === m.effort?.attribute) continue;

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
      labelClaim: labelClaimFromLinearMapping(m),
      state,
      estimate,
      assignee,
      period,
      ...(degradedPeriods !== undefined ? { degradedPeriods } : {}),
    },
    problems,
    resourceGaps,
    periodGaps,
  };
}

/**
 * Pull: a Linear issue record becomes board fields.
 *
 * `title` ← `title`; `body` ← `description` (markdown, with the managed block
 * stripped); `type` ← the mapped labels; `status` ← `state.name`; `assignee` ←
 * the account; `period` ← the cycle the connector enriched onto the record.
 */
export function fieldsFromRecord(
  record: RemoteRecord,
  mapping: Record<string, unknown>,
  attributes: AttributeDefs,
  roster: Roster = new Map(),
  periods: PeriodIndex = new Map(),
): FieldsFromRecordResult {
  const m = mapping as LinearMapping;
  const labels = labelNamesOf(record);
  const patch: BoardFieldsPatch = {};
  const problems: AttributeProblem[] = [];
  const unknownAccounts: UnknownAccount[] = [];
  const result: FieldsFromRecordResult = { patch, problems, unknownAccounts };

  if (typeof record.title === 'string') patch.title = record.title;

  // The managed block is the sync layer's own output, never the document's
  // prose — stripped on the way back so the local body holds what a human
  // wrote (LP-309, LP-314, LP-313).
  let managedFields: Record<string, string> = {};
  if (typeof record.description === 'string') {
    const parsed = parseManagedBlock(record.description);
    patch.body = parsed.found ? parsed.body : record.description;
    if (parsed.found) managedFields = parsed.fields;
  } else if (typeof record.body === 'string') {
    // Defensive: a record that spelled the body `body` rather than Linear's
    // `description`.
    const parsed = parseManagedBlock(record.body);
    patch.body = parsed.found ? parsed.body : record.body;
    if (parsed.found) managedFields = parsed.fields;
  }

  // Type: every board type whose mapped values appear on the issue.
  const typeCandidates = boardTypesMatching(m.types ?? {}, { labels });
  if (typeCandidates.length === 1) patch.type = typeCandidates[0];

  // Status: the native workflow state name resolved through the mapping.
  const remoteStatus = stateNameOf(record);
  if (remoteStatus !== undefined) {
    const resolution = mapStatusFromRemote(m.statuses ?? {}, [remoteStatus]);
    if (resolution.status !== undefined) patch.status = resolution.status;
  }

  // Period: the cycle resolves to a local period by name among the mapped
  // level's periods; its dates ride along for the planner to reconcile
  // (LP-334). The degraded levels above the cycle ride the managed block.
  const periodMapping = normalizePeriodMapping(m.periods);
  if (periodMapping) {
    const name = cycleNameOf(record);
    let starts: string | undefined;
    let ends: string | undefined;
    const cycle = record.cycle;
    if (cycle && typeof cycle === 'object') {
      const observed = cycle as Record<string, unknown>;
      if (typeof observed['startsAt'] === 'string') starts = observed['startsAt'];
      if (typeof observed['endsAt'] === 'string') ends = observed['endsAt'];
    }
    const pull = mapPeriodFromRemote(periods, periodMapping, {
      container: name,
      starts,
      ends,
      degraded: degradedFromBlockFields(managedFields, degradedTypesOf(periods, periodMapping)),
    });
    if (pull.periodId !== undefined) patch.period = pull.periodId;
    result.period = pull;
  }

  // Assignee: the account matched against the roster's `via` value. A pool
  // assignment rides the `pool:` label; an account nobody matches is reported,
  // never invented (LP-271).
  const assignee = record.assignee;
  let account: string | undefined;
  if (assignee && typeof assignee === 'object') {
    const a = assignee as Record<string, unknown>;
    const via = normalizeAccountMapping(m.accounts)?.via;
    if (via === 'email' && typeof a['email'] === 'string') account = a['email'];
    else if (typeof a['id'] === 'string') account = a['id'];
    else if (typeof a['name'] === 'string') account = a['name'];
  }
  const accounts = normalizeAccountMapping(m.accounts);
  // An assignee the remote could not hold rides the managed block (rung 4), and
  // it is recovered by handing the block's value to the same pool resolution the
  // `pool:` label uses — both carry a board resource id, so one reader serves
  // both and there is no second way for an assignee to come back.
  const resolved = mapAssigneeFromRemote(roster, accounts, {
    account,
    labels: withBlockAssignee(labels, managedFields),
  });
  if (resolved.resourceId !== undefined) {
    patch.assignee = resolved.resourceId;
  } else if (resolved.unassigned) {
    patch.assignee = null;
  } else if (resolved.unknown) {
    unknownAccounts.push(resolved.unknown);
  }

  // Attributes: `<prefix>:<value>` labels, coerced back by prefix and type.
  const recovered: Record<string, unknown> = {};
  for (const [attribute, prefix] of Object.entries(m.attributes ?? {})) {
    // The effort attribute rides the native `estimate` field (LP-333), never a
    // label — recovered below from `record.estimate`, not from a prefix.
    if (attribute === m.effort?.attribute) continue;

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
  // Estimate: Linear's native `estimate` recovers the board's effort attribute
  // (LP-333). Absent (`null`) means no estimate — the attribute is left unset.
  if (
    m.effort?.attribute !== undefined &&
    typeof record.estimate === 'number' &&
    Number.isFinite(record.estimate)
  ) {
    recovered[m.effort.attribute] = record.estimate;
  }

  if (Object.keys(recovered).length > 0) patch.attributes = recovered;

  return result;
}

export const linearTranslator: Translator = {
  describeRequest,
  fieldsFromRecord,
};
