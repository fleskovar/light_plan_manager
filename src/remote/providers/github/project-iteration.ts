/**
 * Projects v2 iteration-field read/write (LP-313).
 *
 * Where the board's `period` becomes a Project iteration field, and back again.
 * An iteration field is a `ProjectV2IterationField` whose iterations are fixed
 * duration (set on the field, not per item); the field's *name* is
 * `mapping.fields.period`, and the carrier is `mapping.periods.carrier:
 * iteration`. This module uses LP-310's cached ids (which now carry each
 * iteration's id/title/dates) to move a board period across the wire as an
 * iteration.
 *
 * Push: the period's title resolves to an iteration id among the field's
 * iterations; the issue is added to the Project first when it is not already
 * an item, then the field value is set. A title with no matching iteration is
 * refused with the remedy — a push creates the field and its
 * iterations, and because an iteration's duration is fixed on the field, a
 * board whose mapped periods vary in length is a preflight finding, not
 * something a push quietly rounds (see `preflight.ts`).
 *
 * Pull: the iteration value's `title` is read back off the item; the
 * translator resolves it to a local period exactly as it resolves a milestone
 * title.
 *
 * ## Pure vs I/O
 *
 * `projectIterationFieldOf` and `planProjectIterationWrite` are pure (no disk,
 * no network); the GraphQL documents below them are the network half, driven
 * through the same `connector.graphql` entry point LP-310 added.
 */

import { BoardError } from '../../../core/errors.js';
import type { ProjectGraphqlConnector, ProjectIds } from './projects.js';
import { addProjectItem, findProjectItemId } from './project-status.js';

// ---------------------------------------------------------------------------
// Pure: reading the mapping and planning the write
// ---------------------------------------------------------------------------

/** The Project field name carrying the board's period, or `undefined` when the
 * mapping does not put the period in a Project iteration field. */
export function projectIterationFieldOf(mapping: Record<string, unknown>): string | undefined {
  const fields = mapping['fields'];
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return undefined;
  const value = (fields as Record<string, unknown>)['period'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** What a push needs to write the iteration field for one issue. */
export interface ProjectIterationWrite {
  /** The Project field name (`mapping.fields.period`). */
  field: string;
  /** The iteration title to write — the period's name. */
  title: string;
  /** The iteration id resolved for the title, when the field has it. */
  iterationId?: string;
  /** True when the field has no iteration by that title (provision first). */
  missingIteration: boolean;
}

/**
 * The iteration write a push needs for one period title: the field name, the
 * title, and the iteration id resolved from the cached ids. A title with no
 * matching iteration is a `missingIteration` — reported, never written —
 * because a write against a non-existent iteration is a silent no-op, and the
 * remedy is the push itself, which creates the field before it files.
 */
export function planProjectIterationWrite(
  ids: ProjectIds,
  fieldName: string,
  title: string,
): ProjectIterationWrite {
  const field = ids.fields[fieldName];
  const iteration = (field?.iterations ?? []).find((entry) => entry.title === title);
  return {
    field: fieldName,
    title,
    ...(iteration !== undefined ? { iterationId: iteration.id } : {}),
    missingIteration: iteration === undefined,
  };
}

// ---------------------------------------------------------------------------
// GraphQL documents
// ---------------------------------------------------------------------------

/** Set one iteration field value on an item. */
const SET_ITERATION_MUTATION = `
mutation($input: UpdateProjectV2ItemFieldValueInput!) {
  updateProjectV2ItemFieldValue(input: $input) {
    projectV2Item { id }
  }
}
`;

/** Clear one field value on an item — an iteration the issue no longer sits in. */
const CLEAR_FIELD_MUTATION = `
mutation($input: ClearProjectV2ItemFieldValueInput!) {
  clearProjectV2ItemFieldValue(input: $input) {
    projectV2Item { id }
  }
}
`;

/** Read one iteration field's title off an item. */
const READ_ITERATION_QUERY = `
query($itemId: ID!) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      fieldValues(first: 50) {
        nodes {
          ... on ProjectV2ItemFieldIterationValue {
            field { ... on ProjectV2IterationField { id } }
            title
            startDate
            duration
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
      'Projects v2 iteration values are GraphQL-only, so this provider must expose a GraphQL entry point to read and write them.',
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

/**
 * Set the iteration for one issue: resolve the iteration id, add the issue to
 * the Project when it is not already an item, then write the field value.
 *
 * A missing iteration (a period title the field does not have) is a
 * `BoardError` naming the remedy — the write is refused rather than silently
 * dropped, which is exactly the setup failure the push's prerequisites exist to
 * fix.
 */
export async function setProjectIteration(
  connector: ProjectGraphqlConnector,
  ids: ProjectIds,
  fieldName: string,
  issueNodeId: string,
  title: string,
): Promise<void> {
  const write = planProjectIterationWrite(ids, fieldName, title);
  if (write.missingIteration) {
    throw new BoardError(`Project iteration field "${fieldName}" has no iteration "${title}"`, [
      'A push creates the Project fields the mapping names, but not an iteration — ' +
        'its dates are the Project owner\'s to choose. Add it on the Project, then push again.',
    ]);
  }

  let itemId = await findProjectItemId(connector, ids.project.id, issueNodeId);
  if (itemId === null) {
    itemId = await addProjectItem(connector, ids.project.id, issueNodeId);
  }

  const graphql = graphqlOf(connector);
  const body = await graphql(SET_ITERATION_MUTATION, {
    input: { projectId: ids.project.id, itemId, fieldId: ids.fields[fieldName]!.id, value: { iterationId: write.iterationId } },
  });
  dataOf(body);
}

/**
 * Clear the iteration field for one issue — the issue was unscheduled. The
 * issue is added to the Project first when it is not already an item (the
 * value cannot be cleared on an item that does not exist), exactly as the
 * status write does.
 */
export async function clearProjectIteration(
  connector: ProjectGraphqlConnector,
  ids: ProjectIds,
  fieldName: string,
  issueNodeId: string,
  signal?: AbortSignal,
): Promise<void> {
  const fieldId = ids.fields[fieldName]?.id;
  if (fieldId === undefined) return;

  let itemId = await findProjectItemId(connector, ids.project.id, issueNodeId);
  if (itemId === null) {
    itemId = await addProjectItem(connector, ids.project.id, issueNodeId);
  }

  const graphql = graphqlOf(connector);
  const body = await graphql(CLEAR_FIELD_MUTATION, {
    input: { projectId: ids.project.id, itemId, fieldId },
  });
  dataOf(body);
  void signal;
}

/** Read one iteration field's title off an item, or `undefined`. */
export async function readProjectIteration(
  connector: ProjectGraphqlConnector,
  itemId: string,
  fieldId: string,
): Promise<string | undefined> {
  const graphql = graphqlOf(connector);
  const body = await graphql(READ_ITERATION_QUERY, { itemId });
  const node = dataOf(body)['node'];
  if (!node || typeof node !== 'object') return undefined;

  const values = nodesOf((node as Record<string, unknown>)['fieldValues']);
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const field = record['field'];
    const fieldIdOf =
      field && typeof field === 'object' ? (field as Record<string, unknown>)['id'] : undefined;
    if (fieldIdOf !== fieldId) continue;
    const title = record['title'];
    return typeof title === 'string' ? title : undefined;
  }
  return undefined;
}
