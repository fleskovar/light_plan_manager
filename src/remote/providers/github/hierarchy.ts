/**
 * GitHub's hierarchy read seam (LP-309): the remote parent id a record names.
 *
 * Two carriers, one answer — the native sub-issue edge and the managed block
 * are the two encodings `resolveHierarchyEncoding` chooses between, and this
 * is the pull-side reader for both:
 *
 *   - native: the issue payload's `parent` field (a sub-issue's parent, when
 *     the account has the sub-issue API);
 *   - block: the `parent` row the managed block wrote when the board's depth
 *     exceeded the native edge.
 *
 * It returns the **remote** id in both cases, so the pull planner resolves it
 * exactly as it resolves a native sub-issue parent — through the link store,
 * or through the pending-create map when the parent is pulled in the same run.
 */

import { parentRemoteIdFromBlock } from '../../hierarchy.js';
import type { RemoteRecord } from '../../provider.js';

/** The remote id of a record's native sub-issue parent, when present. */
export function githubNativeParentIdOf(record: RemoteRecord): string | undefined {
  const parent = record['parent'];
  if (typeof parent === 'number') return String(parent);
  if (typeof parent === 'string' && parent !== '') return parent;
  if (parent && typeof parent === 'object' && !Array.isArray(parent)) {
    const number = (parent as { number?: unknown }).number;
    if (typeof number === 'number') return String(number);
    const id = (parent as { id?: unknown }).id;
    if (typeof id === 'number') return String(id);
  }
  return undefined;
}

/** The remote id of a record's parent, native sub-issue or managed block. */
export function githubParentIdOf(record: RemoteRecord): string | undefined {
  const native = githubNativeParentIdOf(record);
  if (native !== undefined) return native;

  const body = record['body'];
  if (typeof body === 'string') {
    return parentRemoteIdFromBlock(body);
  }
  return undefined;
}
