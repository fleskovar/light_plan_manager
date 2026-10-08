/**
 * The desired sets (LP-308): which labels and sprints a remote *should* have,
 * given the board and the mapping. The push creates the missing ones before it
 * files anything (`prerequisites.ts`), and `lpm remote setup` reports them.
 *
 * A GitHub issue can only carry labels the repository already defines, so the
 * first sync onto a fresh repo fails to apply `story` or `Points:3` until those
 * labels exist. This module computes the labels a sync *would* write — every
 * label the mapping derives from the board's current state, plus the mapping's
 * static type and status labels — and, against the repository's own label list,
 * which of them are missing.
 *
 * The pure split mirrors the rest of the remote layer: `desiredLabelsOf` reads
 * the board (no network) and produces the label set; `missingLabels` (in
 * `labels.ts`) subtracts the repository's list; the CLI is a thin printer that
 * calls the connector's `listLabels` / `createLabel`. A dry-run is the same
 * code path with the `createLabel` calls gated off.
 */

import type { LoadedBoard } from '../core/board/load.js';
import { attributeDefsOf, boardFieldsOf, periodIndexOf, rosterOf } from './preflight.js';
import { normalizePeriodMapping } from './periods.js';
import type { BoardOp } from './provider.js';
import type { OpenedRemote } from './remotes.js';
import { isInScope, resolveScope } from './scope.js';

/**
 * Every label a sync would write for the remote's in-scope documents: the
 * labels the translator derives per issue (type, status, attributes, pools)
 * plus the mapping's static type and status labels, which must exist even
 * before any document uses them. Degraded period levels no longer ride labels
 * (LP-313), so nothing here derives a label from the timeline. Deduplicated
 * and sorted.
 *
 * The translator is the single source of the per-issue encoding — the same
 * code path a real push runs — so a label `provision` creates is exactly a
 * label a later sync will write, never a guess.
 */
export function desiredLabelsOf(board: LoadedBoard, remote: OpenedRemote): string[] {
  const labels = new Set<string>();
  const roster = rosterOf(board);
  const periods = periodIndexOf(board);
  const attributeDefs = attributeDefsOf(board);
  const scope = resolveScope(board.issues, remote.scope);

  // The mapping's static labels (type labels, status states) exist independently
  // of any document — the claim is derived from the mapping alone, so a fresh
  // board gets its type and status labels provisioned before its first create.
  const probe: BoardOp = { kind: 'create', localId: '', fields: { type: '', status: '' } };
  const claim = remote.provider.translator.describeRequest(
    probe,
    remote.mapping,
    attributeDefs,
    roster,
    periods,
  ).request.labelClaim;
  if (claim) for (const exact of claim.exact) labels.add(exact);

  for (const issue of board.issues) {
    if (!isInScope(scope, issue.id)) continue;
    const op: BoardOp = { kind: 'create', localId: issue.id, fields: boardFieldsOf(issue) };
    const result = remote.provider.translator.describeRequest(
      op,
      remote.mapping,
      attributeDefs,
      roster,
      periods,
    );
    for (const label of result.request.labels ?? []) labels.add(label);
  }

  return [...labels].sort();
}

/**
 * Every sprint a sync would schedule into, for a remote whose period carrier is
 * a sprint (Jira, LP-328): one entry per board period at the mapped container
 * level, carrying its name and dates. A period at a degraded level (an
 * increment above the mapped sprint) has no sprint to create — its membership
 * rides the managed block.
 */
export function desiredSprintsOf(
  board: LoadedBoard,
  remote: OpenedRemote,
): Array<{ name: string; starts?: string; ends?: string }> {
  const periodMapping = normalizePeriodMapping(remote.mapping['periods']);
  if (!periodMapping) return [];

  const out: Array<{ name: string; starts?: string; ends?: string }> = [];
  for (const period of board.periods) {
    if (period.type !== periodMapping.container) continue;
    out.push({
      name: period.title,
      ...(period.starts !== undefined ? { starts: period.starts } : {}),
      ...(period.ends !== undefined ? { ends: period.ends } : {}),
    });
  }
  return out;
}
