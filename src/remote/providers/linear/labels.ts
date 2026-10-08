/**
 * Linear's label claim and native relation read seams (LP-308, LP-334).
 *
 * The label claim is the same derivation GitHub uses — type labels and status
 * states are exact, attribute prefixes and the reserved `pool:` prefix are
 * prefixes — because Linear's arbitrary attributes ride labels the same way.
 *
 * The relation seams read a Linear issue's native edges back:
 *
 *   - `depends_on` → the `blocks` relation, directional: Linear's relation
 *     reads "issueId blocks relatedIssueId", so a record waits on the source
 *     `issue` of every `blocks` relation in its `inverseRelations` (LP-334);
 *   - `relates_to` → the `related` relation, symmetric.
 *
 * The returned values are **remote ids** (whatever the link store keys by),
 * resolved by the pull planner exactly like a native sub-issue parent.
 */

import type { LabelClaim } from '../../labels.js';
import { labelClaim } from '../../labels.js';
import { parentRemoteIdFromBlock } from '../../hierarchy.js';
import { claimedTypeValues } from '../../mapping.js';
import type { RemoteRecord } from '../../provider.js';
import type { LinearMapping } from './config.js';

/**
 * The labels a Linear mapping claims, derived from its declaration (LP-308).
 * Exact labels are the type labels and the status state names; prefixes are
 * the attribute prefixes and the reserved `pool:` prefix.
 */
export function labelClaimFromLinearMapping(mapping: LinearMapping): LabelClaim {
  const exact: string[] = [];
  const prefixes: string[] = [];

  exact.push(...claimedTypeValues(mapping.types ?? {}));
  for (const entry of Object.values(mapping.statuses ?? {})) {
    exact.push(...entry.remote);
  }
  for (const prefix of Object.values(mapping.attributes ?? {})) {
    if (prefix.length > 0) prefixes.push(`${prefix}:`);
  }
  prefixes.push('pool:');

  return labelClaim(exact, prefixes);
}

/** The `relations` / `inverseRelations` nodes a record carries, or an empty list. */
function relationNodesOf(
  record: RemoteRecord,
  field: 'relations' | 'inverseRelations',
): Array<Record<string, unknown>> {
  const relations = record[field];
  if (!relations || typeof relations !== 'object' || Array.isArray(relations)) return [];
  const nodes = (relations as Record<string, unknown>)['nodes'];
  if (!Array.isArray(nodes)) return [];
  return nodes.filter(
    (node): node is Record<string, unknown> => node !== null && typeof node === 'object',
  );
}

/** The remote id of a relation endpoint (`issue` or `relatedIssue`), or ''. */
function endpointIdOf(node: Record<string, unknown>, key: string): string {
  const endpoint = node[key];
  if (!endpoint || typeof endpoint !== 'object') return '';
  const id = (endpoint as Record<string, unknown>)['id'];
  return typeof id === 'string' ? id : typeof id === 'number' ? String(id) : '';
}

/** The type name of a relation (`blocks`, `related`), or ''. */
function relationTypeOf(node: Record<string, unknown>): string {
  const type = node['type'];
  return typeof type === 'string' ? type : '';
}

/**
 * The remote id of a Linear issue's native parent, when it has one. The pull
 * planner resolves it through the link store exactly like a native sub-issue
 * parent (LP-309).
 *
 * Deeper levels' parent rides the managed block rather than the native edge
 * (LP-334), so the block's `parent` row is read as a fallback — the same
 * two-carrier answer GitHub's seam gives.
 */
export function linearParentIdOf(record: RemoteRecord): string | undefined {
  const parent = record.parent;
  if (parent && typeof parent === 'object') {
    const id = (parent as Record<string, unknown>)['id'];
    if (typeof id === 'string') return id;
    if (typeof id === 'number') return String(id);
  }
  const description = record['description'];
  if (typeof description === 'string') {
    return parentRemoteIdFromBlock(description);
  }
  return undefined;
}

/**
 * The remote ids a Linear issue waits on: the `issue` (the blocker) of every
 * `blocks` relation it carries in its `inverseRelations` (LP-334). Linear's
 * relation reads "issueId blocks relatedIssueId", so a record is the *blocked*
 * side of a relation exactly when the relation appears under `inverseRelations`
 * — the source issue there is the dependency.
 */
export function linearDependsOnOf(record: RemoteRecord): string[] {
  const ids: string[] = [];
  for (const node of relationNodesOf(record, 'inverseRelations')) {
    if (relationTypeOf(node) !== 'blocks') continue;
    const id = endpointIdOf(node, 'issue');
    if (id !== '') ids.push(id);
  }
  return [...new Set(ids)].sort();
}

/**
 * The remote ids a Linear issue relates to: the other side of every `related`
 * relation, whichever side it is carried on. Symmetric — a record's own
 * `relations` name it as the source and its `inverseRelations` as the target,
 * and either orientation is the same edge (LP-334).
 */
export function linearRelatesToOf(record: RemoteRecord): string[] {
  const ids: string[] = [];
  for (const node of relationNodesOf(record, 'relations')) {
    if (relationTypeOf(node) !== 'related') continue;
    const id = endpointIdOf(node, 'relatedIssue');
    if (id !== '') ids.push(id);
  }
  for (const node of relationNodesOf(record, 'inverseRelations')) {
    if (relationTypeOf(node) !== 'related') continue;
    const id = endpointIdOf(node, 'issue');
    if (id !== '') ids.push(id);
  }
  return [...new Set(ids)].sort();
}
