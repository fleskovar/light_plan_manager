import type { LoadedBoard } from '../board/load.js';
import { allowedDepths } from '../config/lookup.js';
import { requirePlacement } from '../board/registry.js';
import { BoardError } from '../errors.js';
import { initialValueFor } from '../model/attributes.js';
import type { AnyNode } from '../model/types.js';
import { nowIso } from '../storage/document.js';
import { writeBoardIndex } from './board-index.js';
import {
  boardWrite,
  relocateFolder,
  requireSubtreeFits,
  requireUnchanged,
  resolveNewParent,
  typeDefOf,
  writeDocument,
} from './shared.js';

export interface RetypeInput {
  type: string;
  /**
   * Where the retyped document should sit. Omit to keep the current parent —
   * which only works when the new type lives at the same depth as the old one.
   * Passing it lets one call do "demote this feature into a story under that
   * other feature", which is what dragging a node onto a node means.
   */
  parentId?: string | null;
}

export interface RetypeResult {
  node: AnyNode;
  movedTo?: string;
}

/**
 * Change a document's type, and optionally its parent at the same time.
 *
 * Attributes are remapped rather than reset: values whose names the new type
 * also declares are kept, attributes only the new type declares are seeded with
 * their initial value, and keys neither type declares stay untouched — `load`
 * preserves those extras and `check` is what reports them.
 */
export function retypeNode(board: LoadedBoard, target: AnyNode, input: RetypeInput): RetypeResult {
  return boardWrite(board, `retype ${target.id}`, () => retypeUnderLock(board, target, input));
}

function retypeUnderLock(board: LoadedBoard, target: AnyNode, input: RetypeInput): RetypeResult {
  requireUnchanged(board, target);
  const newDef = typeDefOf(board, target.kind, input.type);
  const oldDef = target.type ? typeDefOf(board, target.kind, target.type) : null;

  const parent =
    input.parentId === undefined
      ? undefined
      : resolveNewParent(board, target, input.parentId);
  const newDepth = parent === undefined ? target.depth : parent ? parent.depth + 1 : 0;

  // A list, not a number: the registry's `folder` stands in for any level, so
  // "where does this type belong?" can have more than one answer.
  const depths = allowedDepths(board.config, target.kind, input.type);
  if (!depths.includes(newDepth)) {
    throw new BoardError(`"${input.type}" cannot sit at level ${newDepth}`, [
      depths.length
        ? `"${input.type}" belongs at level ${depths.join(' or ')}`
        : `"${input.type}" is not in the ${target.kind} hierarchy`,
    ]);
  }
  if (target.kind === 'template') {
    const holder = parent === undefined
      ? (target.parentId ? board.templatesById.get(target.parentId) ?? null : null)
      : parent;
    requirePlacement(input.type, holder);
  }
  requireSubtreeFits(board, target, newDepth, input.type);

  const attributes: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(newDef.attributes)) {
    attributes[name] = name in target.attributes ? target.attributes[name] : initialValueFor(def);
  }
  for (const [name, value] of Object.entries(target.attributes)) {
    if (!newDef.attributes[name] && !oldDef?.attributes[name]) attributes[name] = value;
  }

  const node: AnyNode = { ...target, type: input.type, attributes };
  const movedTo = parent === undefined ? undefined : relocateFolder(board, node, parent);

  node.updated = nowIso();
  writeDocument(board, node);
  writeBoardIndex(board, { node, ...(movedTo ? { from: target.dir } : {}) });
  return { node, movedTo };
}
