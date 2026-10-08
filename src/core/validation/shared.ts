import type { LoadedBoard } from '../board/load.js';
import { typesFor } from '../config/lookup.js';
import type { AnyNode, BaseNode, NodeKind, TypeDef } from '../model/types.js';
import { displayPath } from '../storage/paths.js';

/** Every collection, in a fixed order, so check and fix always agree. */
export const KINDS: NodeKind[] = ['issue', 'period', 'resource', 'squad', 'template'];

/**
 * A link type light-plan used to have, and the field it becomes.
 *
 * `informed_by` recorded the research an issue rested on and gated the queue
 * exactly as `depends_on` does, which is the whole of what it turned out to
 * mean: two edges with one behaviour, drawn twice on the canvas and asked for
 * twice in every tool. It is gone, and what an issue rests on belongs in its
 * body or its `related_files` — prose, where the reasoning already was.
 *
 * A board written before that still has the key. Nothing reads it any more, so
 * a document carrying one has an ordering the queue no longer honours: `check`
 * reports it as fixable and `--fix` merges the ids into `depends_on`, which is
 * what the edge already did. Both sides read this constant so they cannot
 * disagree about which key is being retired, and `checkCollection` skips it so
 * the reader gets the message that says what to do rather than the generic one.
 */
export const RETIRED_LINK_FIELD = 'informed_by';

/**
 * The ids a document still carries under the retired key, or `null` when the
 * key is not there at all.
 *
 * An undeclared frontmatter key is loaded into `attributes` and written back
 * untouched, which is what keeps a hand-edited board from losing anything — so
 * this is where the leftovers are, and reading them is a list-shaped question
 * `check` and `fix` must not answer two different ways. An empty list is not
 * the same as an absent key: the key is still written into every document on a
 * board that has one, and clearing it is most of what retiring the field means.
 */
export function retiredLink(
  node: BaseNode & { attributes: Record<string, unknown> },
): string[] | null {
  if (!(RETIRED_LINK_FIELD in node.attributes)) return null;
  const value = node.attributes[RETIRED_LINK_FIELD];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  }
  return typeof value === 'string' && value ? [value] : [];
}

/**
 * All three collections, in a fixed order, so the engine's check and fix always
 * agree.
 *
 * `src/shared/model.ts` carries the same function for the browser, flattening a
 * `BoardSnapshot` instead of a `LoadedBoard`. They must agree on the order; the
 * two data shapes are the reason they stay duplicated.
 */
export function allNodes(board: LoadedBoard): AnyNode[] {
  return [
    ...board.issues,
    ...board.periods,
    ...board.resources,
    ...board.squads,
    ...board.templates,
  ];
}

export function typesOf(board: LoadedBoard, kind: NodeKind): Record<string, TypeDef> {
  return typesFor(board.config, kind);
}

/** Where to point the user: the document's path, relative to the board root. */
export function at(board: LoadedBoard, node: BaseNode): string {
  return displayPath(board.paths, node.file);
}
