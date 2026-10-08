/**
 * Projects v2 status-field read/write (LP-312).
 *
 * Where the board's `status` becomes a Project single-select column, and back
 * again. LP-310 resolves and caches the project/field/option node ids; LP-311
 * provisions the field and its options; this module uses both to move a board
 * status across the wire as a Project column.
 *
 * GitHub has **two** independent sources of truth for "is this done": the
 * issue's own `state` (`open`/`closed`) and the Project single-select column.
 * They are not one fact stored twice — a human can close an issue without
 * moving the column, or drag the column without closing the issue. So this
 * module treats them as two observations and reconciles them by a configured
 * precedence (`mapping.status_precedence`), reporting the disagreement rather
 * than silently choosing.
 *
 * ## Push vs pull
 *
 * Push: a status label (the same remote status label the translator writes as
 * a label, LP-269) becomes a Project column value. The issue is added to the
 * Project first when it is not already an item — `addProjectV2ItemById` —
 * because a field value cannot be set on an item that does not exist.
 *
 * Pull: the column's option name and the issue's state are resolved back to a
 * board status. A `closed` issue is the terminal status whatever the column
 * says (default `issue` precedence); a column moved to a non-terminal value
 * while the issue is closed is reported as a discrepancy.
 *
 * ## Pure vs I/O
 *
 * `planProjectStatusWrite` and `resolveProjectStatus` are pure (no disk, no
 * network); the GraphQL documents below them are the network half, driven
 * through the same `connector.graphql` entry point LP-310 added, so a dry-run
 * prints the plan and never reaches them.
 */

import { BoardError } from '../../../core/errors.js';
import {
  mapStatusFromRemote,
  normalizeStatusMappings,
} from '../../mapping.js';
import type { StatusDiscrepancy } from '../../provider.js';
import type { ProjectGraphqlConnector, ProjectIds } from './projects.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which of GitHub's two "done" signals wins when they disagree. */
export type StatusPrecedence = 'issue' | 'project';

/** What the two GitHub signals observed for one issue. */
export interface ProjectStatusObservation {
  /** The Project single-select's option name, when the item has one. */
  column?: string;
  /** The issue's state — `open` or `closed` — when the record carries it. */
  state?: string;
}

/** The resolved board status, plus the disagreement when one was overridden. */
export interface ProjectStatusResolution {
  /** The resolved board status id, when either signal resolved one. */
  status?: string;
  /** A disagreement between the two signals, when one overrode the other. */
  discrepancy?: StatusDiscrepancy;
}

/** What a push needs to write the status column for one issue. */
export interface ProjectStatusWrite {
  /** The Project field name (`mapping.fields.status`). */
  field: string;
  /** The remote status label to write — the column's option name. */
  value: string;
  /** The option id resolved for the value, when the Project field has it. */
  optionId?: string;
  /** True when the field has no option by that name (provision first). */
  missingOption: boolean;
}

// ---------------------------------------------------------------------------
// Pure: reading the mapping
// ---------------------------------------------------------------------------

/** The Project field name carrying the board's status, or `undefined` when the
 * mapping does not put status in a Project field. */
export function projectStatusFieldOf(mapping: Record<string, unknown>): string | undefined {
  const fields = mapping['fields'];
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return undefined;
  const value = (fields as Record<string, unknown>)['status'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The configured precedence, defaulting to `issue`. */
export function statusPrecedenceOf(mapping: Record<string, unknown>): StatusPrecedence {
  return mapping['status_precedence'] === 'project' ? 'project' : 'issue';
}

/** The board status whose mapping says `closed: true`, or `undefined`. */
export function terminalStatusOf(mapping: Record<string, unknown>): string | undefined {
  const statuses = normalizeStatusMappings(
    (mapping['statuses'] as Record<string, unknown> | undefined) ?? {},
  );
  for (const [id, entry] of Object.entries(statuses)) {
    if (entry.closed === true) return id;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pure: the push write plan
// ---------------------------------------------------------------------------

/**
 * The Project status write a push needs for one status label: the field name,
 * the value, and the option id resolved from the cached ids. A value with no
 * matching option is a `missingOption` — reported, never written — because a
 * write against a non-existent option would be a silent no-op or an error, and
 * the remedy is the push itself, which creates the field first (LP-311).
 */
export function planProjectStatusWrite(
  ids: ProjectIds,
  fieldName: string,
  value: string,
): ProjectStatusWrite {
  const optionId = ids.fields[fieldName]?.options[value];
  return {
    field: fieldName,
    value,
    ...(optionId !== undefined ? { optionId } : {}),
    missingOption: optionId === undefined,
  };
}

// ---------------------------------------------------------------------------
// Pure: the pull resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the two GitHub signals — the Project column and the issue state —
 * back to one board status.
 *
 * The column names the specific status (its option names are the remote status
 * labels LP-311 provisioned, resolved through the status mapping). The issue
 * state only names terminality: `closed` is the terminal status, `open` is
 * "not terminal" but names no specific status. So:
 *
 *   - `closed` with no usable column → terminal status (the issue was closed
 *     on GitHub and the column was never moved);
 *   - a column with an `open` or unknown state → the column's status;
 *   - the two disagreeing about terminality → the configured precedence
 *     decides, and the disagreement is reported.
 *
 * A column and state that agree (both terminal, or both non-terminal) resolve
 * with no discrepancy.
 */
export function resolveProjectStatus(
  mapping: Record<string, unknown>,
  observation: ProjectStatusObservation,
  precedence: StatusPrecedence = statusPrecedenceOf(mapping),
): ProjectStatusResolution {
  const statuses = normalizeStatusMappings(
    (mapping['statuses'] as Record<string, unknown> | undefined) ?? {},
  );
  const terminal = terminalStatusOf(mapping);

  const columnStatus =
    observation.column !== undefined && observation.column !== ''
      ? mapStatusFromRemote(statuses, [observation.column]).status
      : undefined;
  const columnTerminal =
    columnStatus !== undefined ? statuses[columnStatus]?.closed === true : undefined;

  const stateTerminal =
    observation.state === 'closed' ? true : observation.state === 'open' ? false : undefined;
  const stateStatus = stateTerminal === true ? terminal : undefined;

  const disagree =
    columnTerminal !== undefined &&
    stateTerminal !== undefined &&
    columnTerminal !== stateTerminal;

  if (!disagree) {
    if (stateStatus !== undefined) return { status: stateStatus };
    if (columnStatus !== undefined) return { status: columnStatus };
    return {};
  }

  // Disagreement: precedence decides which signal's terminality wins. The
  // winning side names the status when it can — the issue state only can when
  // it is `closed` (terminal); an `open` state that wins (precedence `issue`,
  // open issue vs a terminal column) names no specific status, so the status
  // is left absent and the caller falls back to its other carriers.
  const stateWins = precedence === 'issue';
  const win = stateWins ? stateStatus : columnStatus;
  const other = stateWins ? columnStatus : stateStatus;
  return {
    ...(win !== undefined ? { status: win } : {}),
    discrepancy: {
      column: observation.column,
      state: observation.state,
      took: precedence,
      ...(other !== undefined ? { otherStatus: other } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// GraphQL documents
// ---------------------------------------------------------------------------

/** Find the issue's item in the Project, matched by project id. */
const FIND_ITEM_QUERY = `
query($issueId: ID!) {
  node(id: $issueId) {
    ... on Issue {
      projectItems(first: 100) {
        nodes {
          id
          project { id }
        }
      }
    }
  }
}
`;

/** Add an issue to a Project, returning the new item's id. */
const ADD_ITEM_MUTATION = `
mutation($input: AddProjectV2ItemByIdInput!) {
  addProjectV2ItemById(input: $input) {
    item { id }
  }
}
`;

/** Set one single-select field value on an item. */
const SET_FIELD_MUTATION = `
mutation($input: UpdateProjectV2ItemFieldValueInput!) {
  updateProjectV2ItemFieldValue(input: $input) {
    projectV2Item { id }
  }
}
`;

/** Read one single-select field's option name off an item. */
const READ_FIELD_QUERY = `
query($itemId: ID!) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      fieldValues(first: 50) {
        nodes {
          ... on ProjectV2ItemFieldSingleSelectValue {
            field { ... on ProjectV2Field { id } }
            name
            optionId
          }
        }
      }
    }
  }
}
`;

// ---------------------------------------------------------------------------
// The network half
// ---------------------------------------------------------------------------

/** The `graphql` entry point, or a `BoardError` when the connector has none. */
function graphqlOf(
  connector: ProjectGraphqlConnector,
): (query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>> {
  if (typeof connector.graphql !== 'function') {
    throw new BoardError(`The ${connector.name} connector has no GraphQL API`, [
      'Projects v2 field values are GraphQL-only, so this provider must expose a GraphQL entry point to read and write them.',
    ]);
  }
  return connector.graphql.bind(connector);
}

/** Read `body.data` as a plain record, or throw when the platform errored. */
function dataOf(body: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (body && typeof body === 'object') {
    const errors = body['errors'];
    if (Array.isArray(errors) && errors.length > 0) {
      const first = (errors[0] as { message?: unknown } | undefined)?.message;
      throw new BoardError('GitHub GraphQL answered with errors', [
        typeof first === 'string' ? first : JSON.stringify(errors[0]),
      ]);
    }
    const data = body['data'];
    if (data && typeof data === 'object') return data as Record<string, unknown>;
  }
  return {};
}

/** Read a GraphQL response's `nodes` list. */
function nodesOf(connection: unknown): unknown[] {
  if (!connection || typeof connection !== 'object') return [];
  const nodes = (connection as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? nodes : [];
}

/** The Project item id for an issue already in the project, or `null`. */
export async function findProjectItemId(
  connector: ProjectGraphqlConnector,
  projectId: string,
  issueNodeId: string,
): Promise<string | null> {
  const graphql = graphqlOf(connector);
  const body = await graphql(FIND_ITEM_QUERY, { issueId: issueNodeId });
  const node = dataOf(body)['node'];
  if (!node || typeof node !== 'object') return null;

  const items = nodesOf((node as Record<string, unknown>)['projectItems']);
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = record['id'];
    const project = record['project'];
    if (typeof id !== 'string') continue;
    if (project && typeof project === 'object' && (project as Record<string, unknown>)['id'] === projectId) {
      return id;
    }
  }
  return null;
}

/** Add an issue to a Project, returning the new item's id. */
export async function addProjectItem(
  connector: ProjectGraphqlConnector,
  projectId: string,
  issueNodeId: string,
): Promise<string> {
  const graphql = graphqlOf(connector);
  const body = await graphql(ADD_ITEM_MUTATION, {
    input: { projectId, contentId: issueNodeId },
  });
  const data = dataOf(body);
  const payload = data['addProjectV2ItemById'];
  const item =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>)['item'] : undefined;
  const id = item && typeof item === 'object' ? (item as Record<string, unknown>)['id'] : undefined;
  if (typeof id !== 'string') {
    throw new BoardError(`Cannot add the issue to the Project`, [
      'GitHub did not return a Project item id.',
      'The credential needs write access to the Project.',
    ]);
  }
  return id;
}

/** Set one single-select field value on an item. */
export async function setProjectItemFieldValue(
  connector: ProjectGraphqlConnector,
  projectId: string,
  itemId: string,
  fieldId: string,
  optionId: string,
): Promise<void> {
  const graphql = graphqlOf(connector);
  const body = await graphql(SET_FIELD_MUTATION, {
    input: { projectId, itemId, fieldId, value: { singleSelectOptionId: optionId } },
  });
  dataOf(body);
}

/** Read one single-select field's option name off an item, or `undefined`. */
export async function readProjectItemFieldValue(
  connector: ProjectGraphqlConnector,
  itemId: string,
  fieldId: string,
): Promise<string | undefined> {
  const graphql = graphqlOf(connector);
  const body = await graphql(READ_FIELD_QUERY, { itemId });
  const node = dataOf(body)['node'];
  if (!node || typeof node !== 'object') return undefined;

  const values = nodesOf((node as Record<string, unknown>)['fieldValues']);
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const field = record['field'];
    const fieldRecordId =
      field && typeof field === 'object' ? (field as Record<string, unknown>)['id'] : undefined;
    if (fieldRecordId !== fieldId) continue;
    const name = record['name'];
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}

/**
 * Set the status column for one issue: resolve the option id, add the issue to
 * the Project when it is not already an item, then write the field value.
 *
 * A missing option (a status label the Project does not have) is a `BoardError`
 * naming the remedy — the write is refused rather than silently dropped, which
 * is exactly the setup failure the push's prerequisite step (LP-311) fixes.
 */
export async function setProjectStatusField(
  connector: ProjectGraphqlConnector,
  ids: ProjectIds,
  fieldName: string,
  issueNodeId: string,
  value: string,
): Promise<void> {
  const write = planProjectStatusWrite(ids, fieldName, value);
  if (write.missingOption) {
    throw new BoardError(`Project field "${fieldName}" has no option "${value}"`, [
      'A push creates the Project fields and options the mapping names; this one could not be created, so add it on the Project and push again.',
    ]);
  }

  let itemId = await findProjectItemId(connector, ids.project.id, issueNodeId);
  if (itemId === null) {
    itemId = await addProjectItem(connector, ids.project.id, issueNodeId);
  }
  await setProjectItemFieldValue(connector, ids.project.id, itemId, ids.fields[fieldName]!.id, write.optionId!);
}
