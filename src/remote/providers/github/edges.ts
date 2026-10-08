/**
 * GitHub's managed-block edge read seam (LP-314): the dependency and relate
 * references a remote issue's managed block carries.
 *
 * GitHub holds no native `depends_on` / `relates_to` edge, so both ride the
 * managed block as `#418` references.  This file reads them back out on the
 * pull side: same-repo references come back as bare remote ids (the issue
 * number after the `#`) and are resolved through the link store by the pull
 * planner exactly like a native edge; a cross-repository reference
 * (`owner/repo#12`) is recognised as out of scope and left alone; anything
 * else is reported, never silently resolved.
 *
 * Pure: no I/O.  The block codec does the parsing; this file only names the
 * two rows the writer fills.
 */

import { parseManagedBlock, parseManagedRefs } from '../../managed-block.js';
import type { BlockEdges } from '../../plan.js';
import type { RemoteRecord } from '../../provider.js';

/** The block rows that carry edges (LP-314). */
export const DEPENDS_FIELD = 'depends_on';
export const RELATES_FIELD = 'relates_to';

/** An empty result — no block, or no edge rows. */
function empty(): BlockEdges {
  return { dependsOn: [], relatesTo: [], crossRepo: [], unknown: [] };
}

/**
 * Read the edge references out of a record's managed block.
 *
 * Returns `empty()` when the record has no body, no well-formed block, or no
 * `depends_on` / `relates_to` row — a provider that never wrote a block reads
 * as "no edges", never as a failure.  A row a human mangled degrades to
 * `unknown` references, which the planner reports rather than resolving.
 */
export function githubBlockEdgesOf(record: RemoteRecord): BlockEdges {
  const body = record['body'];
  if (typeof body !== 'string') return empty();

  const parsed = parseManagedBlock(body);
  if (!parsed.found) return empty();

  const out = empty();
  for (const field of [DEPENDS_FIELD, RELATES_FIELD] as const) {
    const cell = parsed.fields[field];
    if (cell === undefined) continue;

    const { refs, crossRepo, unknown } = parseManagedRefs(cell);
    if (field === DEPENDS_FIELD) out.dependsOn.push(...refs);
    else out.relatesTo.push(...refs);
    for (const reference of crossRepo) out.crossRepo.push({ field, reference });
    for (const reference of unknown) out.unknown.push({ field, reference });
  }
  return out;
}
