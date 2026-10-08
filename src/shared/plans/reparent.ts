import type { Change, NodePatch } from '../changes.js';
import type { NodeDto } from '../model.js';
import type { BoardView, IdFactory } from './reading.js';
import { ancestorsOf, subtreeIds, typeAtDepth } from './reading.js';
import { create, fail, update } from './breakdown.js';
import type { Plan } from './breakdown.js';

// -- reparenting ------------------------------------------------------------

export interface ReparentPreview {
  /** The type the document ends up with; different means it was demoted. */
  type: string;
  allowed: boolean;
  /** Why not, when it is not allowed. */
  reason?: string;
}

/**
 * Would everything under `id` still have a level to sit at, if `id` itself
 * ended up at `depth`? Returns the reason it would not, or null.
 */
function descendantsFit(view: BoardView, id: string, depth: number): string | null {
  const node = view.nodes[id];
  if (!node) return `No document with id "${id}"`;
  for (const descendantId of subtreeIds(view, id)) {
    if (descendantId === id) continue;
    const descendant = view.nodes[descendantId]!;
    const allowed = view.config.hierarchy[node.kind][depth + (descendant.depth - node.depth)] ?? [];
    if (!allowed.includes(descendant.type)) {
      const label = view.config.types[descendant.type]?.label ?? descendant.type;
      return `${descendantId} (${label}) would have nowhere to sit`;
    }
  }
  return null;
}

/**
 * What moving `id` under `parentId` would do, without doing it.
 *
 * The dragged document is not the only thing that has to fit: everything under
 * it moves down the same number of levels, and every descendant must still have
 * a type at the resulting depth.
 */
export function previewReparent(
  view: BoardView,
  id: string,
  parentId: string | null,
): ReparentPreview {
  const node = view.nodes[id];
  if (!node) return { type: '', allowed: false, reason: `No document with id "${id}"` };

  if (parentId === null) {
    const depth = 0;
    const type = typeAtDepth(view.config, node.kind, depth, node.type);
    if (!type) {
      return { type: node.type, allowed: false, reason: `${node.type} cannot sit at the top level` };
    }
    const reason = descendantsFit(view, id, depth);
    if (reason) return { type, allowed: false, reason };
    return { type, allowed: true };
  }

  const parent = view.nodes[parentId];
  if (!parent) {
    return { type: node.type, allowed: false, reason: `No document with id "${parentId}"` };
  }
  if (parent.kind !== node.kind) {
    return {
      type: node.type,
      allowed: false,
      reason: `Cannot move a ${node.kind} under a ${parent.kind}`,
    };
  }
  if (parentId === id) {
    return { type: node.type, allowed: false, reason: 'A document cannot be its own parent' };
  }
  if (subtreeIds(view, id).includes(parentId)) {
    return {
      type: node.type,
      allowed: false,
      reason: `Cannot move ${id} under its own descendant ${parentId}`,
    };
  }

  const depth = parent.depth + 1;
  const type = typeAtDepth(view.config, node.kind, depth, node.type);
  if (!type) {
    const label = view.config.types[node.type]?.label ?? node.type;
    return {
      type: node.type,
      allowed: false,
      reason: `"${label}" cannot sit under "${parent.type}"`,
    };
  }

  const reason = descendantsFit(view, id, depth);
  if (reason) return { type, allowed: false, reason };

  return { type, allowed: true };
}

/**
 * The two ways of putting `id` under `parentId` when it does not fit directly.
 * The callers — the CLI and the MCP server — present these side by side so the
 * reader picks which one to apply, and the web canvas runs the same check so
 * the UI finds out which of them are actually available.
 */
export interface ReparentChoices {
  /** Demoting the document's type to whatever fits under the new parent. */
  convert: ReparentPreview;
  /**
   * Container types to create between the new parent and the document, so it
   * keeps the type it has. Empty when that cannot help: a document never needs
   * containers to move *up*, and it cannot have them if the levels in between
   * declare no types.
   */
  bridge: string[];
}

export function reparentChoices(
  view: BoardView,
  id: string,
  parentId: string | null,
): ReparentChoices {
  const convert = previewReparent(view, id, parentId);
  const none = { convert, bridge: [] };

  const node = view.nodes[id];
  if (!node) return none;
  const parent = parentId ? view.nodes[parentId] : null;
  if (parentId && (!parent || parent.kind !== node.kind)) return none;
  if (parentId && subtreeIds(view, id).includes(parentId)) return none;

  const targetDepth = parent ? parent.depth + 1 : 0;
  // Where this document's *type* belongs, which is the depth bridging keeps it
  // at — that is the whole difference between the two options.
  const ownDepth = view.config.types[node.type]?.depth ?? node.depth;
  if (ownDepth <= targetDepth) return none;
  if (descendantsFit(view, id, ownDepth)) return none;

  const bridge: string[] = [];
  for (let depth = targetDepth; depth < ownDepth; depth += 1) {
    const allowed = view.config.hierarchy[node.kind][depth] ?? [];
    if (!allowed.length) return none;
    bridge.push(allowed[0]!);
  }
  return { convert, bridge };
}

export interface BridgeOptions {
  /** Titles for the containers, outermost first; short lists are filled in. */
  titles?: string[];
}

/**
 * Move a document under a new parent by *building the levels it is missing*.
 *
 * The alternative to demoting a type: drop a user story onto a program and the
 * epic and feature it needs are created on the way, with the story keeping the
 * type — and so keeping whatever is nested under it exactly where it was.
 */
export function planBridgeReparent(
  view: BoardView,
  nextId: IdFactory,
  id: string,
  parentId: string | null,
  options: BridgeOptions = {},
): Plan {
  const node = view.nodes[id];
  if (!node) return fail(`No document with id "${id}"`);

  const { bridge } = reparentChoices(view, id, parentId);
  if (!bridge.length) {
    return fail(`Nothing can be created to hold ${id} there`, [
      'Convert it to a type that fits under the new parent instead.',
    ]);
  }

  const changes: Change[] = [];
  const created: string[] = [];
  let holder = parentId;

  for (const [index, type] of bridge.entries()) {
    const label = view.config.types[type]?.label ?? type;
    const containerId = nextId();
    changes.push(
      create(containerId, node.kind, {
        type,
        title: options.titles?.[index]?.trim() || `${label} for ${node.title}`,
        parentId: holder,
      }),
    );
    created.push(containerId);
    holder = containerId;
  }

  changes.push(update(view, id, { parentId: holder }));
  return { ok: true, changes, created };
}

/** Move a document under a new parent, demoting its type when the depth demands it. */
export function planReparent(view: BoardView, id: string, parentId: string | null): Plan {
  const node = view.nodes[id];
  if (!node) return fail(`No document with id "${id}"`);

  const preview = previewReparent(view, id, parentId);
  if (!preview.allowed) return fail(preview.reason ?? 'That move is not allowed');

  return {
    ok: true,
    created: [],
    changes: [
      update(view, id, {
        parentId,
        ...(preview.type !== node.type ? { type: preview.type } : {}),
      }),
    ],
  };
}

/**
 * Change a document's type. A type that belongs at a different depth takes the
 * document with it, to the ancestor that can hold it.
 */
export function planConvert(view: BoardView, id: string, type: string): Plan {
  const node = view.nodes[id];
  if (!node) return fail(`No document with id "${id}"`);

  const target = view.config.types[type];
  if (!target) {
    const available = Object.values(view.config.types)
      .filter((entry) => entry.kind === node.kind)
      .map((entry) => entry.name);
    return fail(`Unknown ${node.kind} type "${type}"`, [`Available: ${available.join(', ')}`]);
  }
  if (target.kind !== node.kind) {
    return fail(`"${type}" is a ${target.kind} type; ${id} is a ${node.kind}`);
  }
  if (type === node.type) return { ok: true, changes: [], created: [] };

  const patch: NodePatch = { type };
  if (target.depth !== node.depth) {
    if (target.depth === 0) {
      patch.parentId = null;
    } else if (target.depth < node.depth) {
      // Promoting: hand it to the ancestor that sits one level above the new type.
      const ancestor = ancestorsOf(view, id)[node.depth - target.depth];
      if (!ancestor) return fail(`${id} has no ancestor to hold a "${type}"`);
      patch.parentId = ancestor.id;
    } else {
      return fail(`"${type}" sits below ${id}`, [
        'Move it under a new parent first; dropping a node onto another demotes it.',
      ]);
    }
  }

  const projected: BoardView = {
    ...view,
    nodes: { ...view.nodes, [id]: { ...node, type, depth: target.depth } as NodeDto },
  };
  for (const descendantId of subtreeIds(view, id)) {
    if (descendantId === id) continue;
    const descendant = projected.nodes[descendantId]!;
    const depth = target.depth + (descendant.depth - node.depth);
    const allowed = view.config.hierarchy[node.kind][depth] ?? [];
    if (!allowed.includes(descendant.type)) {
      const label = view.config.types[descendant.type]?.label ?? descendant.type;
      return fail(`${descendantId} (${label}) would have nowhere to sit`);
    }
  }

  return { ok: true, changes: [update(view, id, patch)], created: [] };
}
