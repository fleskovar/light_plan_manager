/**
 * The jsonfile provider's two-way vocabulary translation.
 *
 * The JSON-file tracker is the *minimum* a tracker can be, and it holds its
 * vocabulary natively rather than on labels:
 *
 *   - **type** is the native `type` field (rung 1), with an optional human
 *     label kept beside it (rung 3) so the sync's label claim still has an
 *     exact label to reconcile and a person reading the file sees the type;
 *   - **status** is the native `status` field (rung 1) — the mapping's
 *     `statuses.*.remote` value is the field value, exactly as Linear's
 *     workflow-state name is;
 *   - **attributes** ride label prefixes (rung 3), as GitHub's do — the file
 *     has no typed custom-field registry;
 *   - **`depends_on`** is the native `depends_on` array (rung 1), handled by
 *     the connector's `link` / `unlink` rather than here.
 *
 * Assignees and periods are deliberately not mapped in this slice: the file
 * holds an arbitrary `assignee` string and no period container, so both ride
 * the ladder (and the managed block for a degraded period level).
 *
 * Pure: no I/O. One translator serves every jsonfile remote; the mapping and
 * the board's attribute definitions are passed per call.
 */

import type { AttributeDef } from '../../../core/model/types.js';
import {
  coerceFromRemote,
  coerceToRemote,
  type AttributeProblem,
  type RemoteField,
} from '../../attributes.js';
import { labelClaim, type LabelClaim } from '../../labels.js';
import { parseManagedBlock } from '../../managed-block.js';
import {
  boardTypesMatching,
  mapStatusFromRemote,
  mapStatusToRemote,
  mapTypeToRemote,
} from '../../mapping.js';
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
import type { JsonfileMapping } from './config.js';

/** An issue's labels as plain strings, whatever the record's spelling. */
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

/** The remote field a board attribute of this type lands on: labels only. */
function fieldFor(type: AttributeDef['type']): RemoteField {
  return type === 'array' ? { kind: 'labels' } : { kind: 'text' };
}

/** Skip a value that carries nothing to write. */
function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * The labels a mapping claims (LP-308): the exact type labels and status
 * states, and the attribute prefixes. Derived from the mapping, never a
 * convention.
 */
export function labelClaimFromJsonfileMapping(mapping: JsonfileMapping): LabelClaim {
  const exact: string[] = [];
  const prefixes: string[] = [];

  // The type rides the native `type` field, not a label, so the claim covers
  // only the statuses and the attribute prefixes.
  for (const entry of Object.values(mapping.statuses ?? {})) {
    exact.push(...entry.remote);
  }
  for (const prefix of Object.values(mapping.attributes ?? {})) {
    if (prefix.length > 0) prefixes.push(`${prefix}:`);
  }

  return labelClaim(exact, prefixes);
}

/**
 * Push: a board op becomes a jsonfile request description.
 *
 * A create/update carries `title`, `body`, the native `type`, the native
 * status name in `state`, and the labels derived from the mapping (the type
 * labels plus one `<prefix>:<value>` label per mapped attribute). An attribute
 * value that will not coerce is omitted and reported in `problems`. A delete
 * carries only its kind — the connector removes the issue from the file.
 */
export function describeRequest(
  op: BoardOp,
  mapping: Record<string, unknown>,
  attributes: AttributeDefs,
  _roster = new Map(),
  _periods = new Map(),
): DescribeResult {
  if (op.kind === 'delete') {
    return { request: { kind: 'delete' }, problems: [], resourceGaps: [], periodGaps: [] };
  }

  const m = mapping as JsonfileMapping;
  const labels: string[] = [];
  const problems: AttributeProblem[] = [];
  let state: string | undefined;

  // The file has a native `type` field, so the mapped value is written there
  // and nowhere else — writing it as a label too would be the same fact twice.
  const type = mapTypeToRemote(m.types ?? {}, op.fields.type);

  const remoteStatus = mapStatusToRemote(m.statuses ?? {}, op.fields.status);
  if (remoteStatus !== undefined) state = remoteStatus;

  for (const [attribute, prefix] of Object.entries(m.attributes ?? {})) {
    const value = op.fields.attributes?.[attribute];
    if (isEmptyValue(value)) continue;

    const attributeType = attributes[attribute]?.type ?? 'string';
    const field = fieldFor(attributeType);
    const result = coerceToRemote(attributeType, value, field);
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
      type,
      labels,
      labelClaim: labelClaimFromJsonfileMapping(m),
      state,
    },
    problems,
    resourceGaps: [],
    periodGaps: [],
  };
}

/**
 * Pull: a jsonfile issue record becomes board fields.
 *
 * `title` and `body` pass through (the managed block stripped, as everywhere);
 * `type` is recovered when exactly one board type's native `remote` or labels
 * match; `status` from the native `status` field; `attributes` from
 * `<prefix>:<value>` labels. Ambiguity leaves the field absent — the pull
 * planner breaks ties with the board's hierarchy.
 */
export function fieldsFromRecord(
  record: RemoteRecord,
  mapping: Record<string, unknown>,
  attributes: AttributeDefs,
  _roster = new Map(),
  _periods = new Map(),
): FieldsFromRecordResult {
  const m = mapping as JsonfileMapping;
  const labels = labelsOf(record);
  const patch: BoardFieldsPatch = {};
  const problems: AttributeProblem[] = [];
  const result: FieldsFromRecordResult = { patch, problems, unknownAccounts: [] };

  if (typeof record.title === 'string') patch.title = record.title;

  // The managed block is the sync layer's own output, never the document's
  // prose — stripped on the way back (LP-309, LP-314).
  if (typeof record.body === 'string') {
    const parsed = parseManagedBlock(record.body);
    patch.body = parsed.found ? parsed.body : record.body;
  }

  // Type: every board type whose mapped values match the native `type` field.
  const remoteType = typeof record.type === 'string' ? record.type : undefined;
  const typeCandidates = boardTypesMatching(m.types ?? {}, { remoteType, labels });
  if (typeCandidates.length === 1) patch.type = typeCandidates[0];

  // Status: the native status name resolved through the mapping.
  if (typeof record.status === 'string' && record.status !== '') {
    const resolution = mapStatusFromRemote(m.statuses ?? {}, [record.status]);
    if (resolution.status !== undefined) patch.status = resolution.status;
  }

  // Attributes: `<prefix>:<value>` labels, coerced back by prefix and type.
  const recovered: Record<string, unknown> = {};
  for (const [attribute, prefix] of Object.entries(m.attributes ?? {})) {
    const attributeType = attributes[attribute]?.type ?? 'string';
    const field = fieldFor(attributeType);

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
    const coerced = coerceFromRemote(attributeType, raw, { values: attributes[attribute]?.values });
    if (coerced.ok) {
      recovered[attribute] = coerced.value;
    } else {
      problems.push({ attribute, direction: 'pull', reason: coerced.reason, options: coerced.options });
    }
  }
  if (Object.keys(recovered).length > 0) patch.attributes = recovered;

  return result;
}

export const jsonfileTranslator: Translator = {
  describeRequest,
  fieldsFromRecord,
};
