/**
 * Jira's hierarchy read seam: the remote parent id a record names.
 *
 * Two carriers, one answer — the same shape as the GitHub seam, because
 * `resolveHierarchyEncoding` makes the same choice for every provider:
 *
 *   - native: `fields.parent`, the Jira parent edge, which on this
 *     leaf-anchored provider carries the work items under their container;
 *   - block: the `parent` row the managed block wrote for the levels above,
 *     where Jira's own hierarchy has no room (an Epic cannot sit under an
 *     Epic).
 *
 * It returns the **remote** id in both cases, so the pull planner resolves it
 * exactly as it resolves any other parent — through the link store, or through
 * the pending-create map when the parent arrives in the same run.
 *
 * Without this, `pullSeamsFor` gave Jira no `parentIdOf` at all: an issue
 * pulled from Jira never landed under its mirrored parent, and `lpm remote
 * pull SCRUM-856` refused an issue whose parent light-plan was already
 * mirroring, asking for a `--parent` it did not need.
 *
 * Pure: no I/O.
 */

import { parentRemoteIdFromBlock } from '../../hierarchy.js';
import type { RemoteRecord } from '../../provider.js';
import { bodyFromDescription } from './translator.js';

/** The fields object a Jira record carries, or an empty one. */
function fieldsOf(record: RemoteRecord): Record<string, unknown> {
  const fields = record['fields'];
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {};
  return fields as Record<string, unknown>;
}

/** The remote id of a record's native Jira parent, when it has one. */
export function jiraNativeParentIdOf(record: RemoteRecord): string | undefined {
  const parent = fieldsOf(record)['parent'];
  if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return undefined;
  const id = (parent as { id?: unknown }).id;
  if (typeof id === 'string' && id !== '') return id;
  if (typeof id === 'number') return String(id);
  // A record fetched with a field list may carry only the key.
  const key = (parent as { key?: unknown }).key;
  if (typeof key === 'string' && key !== '') return key;
  return undefined;
}

/** The remote id of a record's parent, native edge or managed block. */
export function jiraParentIdOf(record: RemoteRecord): string | undefined {
  const native = jiraNativeParentIdOf(record);
  if (native !== undefined) return native;

  // The block rides the description, which Jira returns as ADF — so it is read
  // through the translator's own converter rather than a second one, or the
  // two would disagree about what a body says.
  const body = bodyFromDescription(fieldsOf(record)['description']);
  return body === undefined ? undefined : parentRemoteIdFromBlock(body);
}
