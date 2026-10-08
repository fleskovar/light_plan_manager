/**
 * Jira's native issue-link read seams (LP-325): `depends_on` and `relates_to`
 * recovered from the `issuelinks` field a Jira record carries.
 *
 * **An issue's `issuelinks` entry names only the *other* end.** This is the
 * thing to get right, and it was got wrong: an entry carries `inwardIssue`
 * *or* `outwardIssue`, never both, and the key says what the other issue is
 * relative to this one. So there is no "is this end me?" test to make — the
 * record is always the end that is missing — and code that compared the
 * record against both endpoints matched nothing at all, which is why every
 * dependency read back from a live Jira came out empty.
 *
 * What the keys mean, measured against Jira Cloud rather than read off the
 * field names (they invite the opposite reading):
 *
 *   - `depends_on` → the `Blocks` link type. An entry carrying
 *     `inwardIssue: Y` reads "this issue **is blocked by** Y", so Y is a
 *     dependency of the record. An entry carrying `outwardIssue: Y` reads
 *     "this issue **blocks** Y" — the same edge seen from the other side, and
 *     nothing this record waits on.
 *   - `relates_to` → the `Relates` link type, symmetric. Either key holds the
 *     other side, and both mean the same thing.
 *
 * The returned values are **remote ids** (the numeric issue id the link store
 * keys by), resolved by the pull planner exactly like a native sub-issue
 * parent — through the link store, or through the pending-create map when the
 * other endpoint is pulled in the same run.
 *
 * Pure: no I/O.
 */

import type { RemoteRecord } from '../../provider.js';

/** A link endpoint (`outwardIssue` / `inwardIssue`) reduced to id and key. */
interface Endpoint {
  id: string;
  key: string;
}

/** The `issuelinks` entries a record carries, or an empty list. */
function issueLinksOf(record: RemoteRecord): Array<Record<string, unknown>> {
  const fields = record['fields'];
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return [];
  const links = (fields as Record<string, unknown>)['issuelinks'];
  if (!Array.isArray(links)) return [];
  return links.filter(
    (link): link is Record<string, unknown> => link !== null && typeof link === 'object',
  );
}

/** The name of a link's type (`Blocks`, `Relates`), or ''. */
function typeNameOf(link: Record<string, unknown>): string {
  const type = link['type'];
  if (!type || typeof type !== 'object') return '';
  const name = (type as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : '';
}

/** An endpoint's id and key, each empty when absent. */
function endpointOf(value: unknown): Endpoint {
  if (!value || typeof value !== 'object') return { id: '', key: '' };
  const record = value as Record<string, unknown>;
  const id = record['id'];
  const key = record['key'];
  return {
    id: typeof id === 'string' ? id : typeof id === 'number' ? String(id) : '',
    key: typeof key === 'string' ? key : '',
  };
}

/** A remote id from an endpoint, preferring the numeric id the link store keys by. */
function remoteIdOf(endpoint: Endpoint): string {
  return endpoint.id !== '' ? endpoint.id : endpoint.key;
}

/**
 * The remote ids of the issues `record` waits on: the outward ("blocks") issue
 * of every `Blocks` link the record is inward ("is blocked by") of.
 */
export function jiraDependsOnOf(record: RemoteRecord): string[] {
  const ids: string[] = [];
  for (const link of issueLinksOf(record)) {
    if (typeNameOf(link) !== 'Blocks') continue;
    // `inwardIssue` present = "this issue is blocked by that one", which is
    // exactly a dependency. An `outwardIssue` entry is the reverse edge and
    // belongs to the other issue's list, not this one's.
    if (link['inwardIssue'] === undefined) continue;
    const id = remoteIdOf(endpointOf(link['inwardIssue']));
    if (id !== '') ids.push(id);
  }
  return [...new Set(ids)].sort();
}

/**
 * The remote ids of the issues `record` relates to: the other side of every
 * `Relates` link, whichever orientation the record sits on.
 */
export function jiraRelatesToOf(record: RemoteRecord): string[] {
  const ids: string[] = [];
  for (const link of issueLinksOf(record)) {
    if (typeNameOf(link) !== 'Relates') continue;
    // Symmetric, so whichever key holds the other end is the target.
    const other = link['inwardIssue'] !== undefined ? link['inwardIssue'] : link['outwardIssue'];
    const id = remoteIdOf(endpointOf(other));
    if (id !== '') ids.push(id);
  }
  return [...new Set(ids)].sort();
}
