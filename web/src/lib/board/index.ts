import type { NodeDto, NodeKind } from '$shared';
import type { WorkingNodes } from './working.js';

/**
 * A parent→children index over the flat working copy, plus a dependents map
 * and O(1) child counts, built in one pass.
 *
 * Designed for incremental maintenance at the single applier in `working.ts`
 * (§1.6 of the assessment), not for naive `$derived` re-derivation from the
 * deep proxy — the workspace rebuilds it from scratch on open/pull/push and
 * patches it per-change in between.
 */
export interface NodeIndex {
  /** Direct children of `id`, or roots when `id` is null. */
  childrenOf(id: string | null): NodeDto[];
  /** Depth-first ids of the subtree rooted at `id`. Runs in O(subtree size). */
  subtreeIds(id: string): string[];
  /** Root nodes of one collection, the way `rootsOf` in selectors.ts does. */
  rootsOf(kind: NodeKind): NodeDto[];
  /** O(1) — does this id appear as any node's parentId? */
  hasChildren(id: string): boolean;
  /** The ids that depend on `id` (the inverse of `dependsOn`). */
  dependentsOf(id: string): string[];
  /** Nearest ancestor first, the way `ancestorsOf` in selectors.ts does. */
  ancestorsOf(id: string): NodeDto[];
  /** O(1) parent lookup via the internal id→node map. */
  parentOf(id: string): NodeDto | undefined;
}

export class NodeIndexImpl implements NodeIndex {
  /** Speed up `childrenOf`: node refs by parent id (null for roots). */
  readonly #children: Map<string | null, NodeDto[]>;
  /** Speed up `hasChildren`: how many nodes name this id as parent. */
  readonly #childCount: Map<string, number>;
  /** Roots by kind, for `rootsOf`. */
  readonly #roots: Map<NodeKind, NodeDto[]>;
  /** Inverse of `dependsOn`, for `dependentsOf`. */
  readonly #dependents: Record<string, string[]>;
  /**
   * Direct id→NodeDto lookup so `ancestorsOf` and `remove` work without
   * `WorkingNodes` — the index stays self-sufficient across incremental edits.
   */
  readonly #byId: Map<string, NodeDto>;

  constructor(nodes: WorkingNodes) {
    this.#children = new Map();
    this.#childCount = new Map();
    this.#roots = new Map();
    this.#dependents = {};
    this.#byId = new Map();

    for (const node of Object.values(nodes)) {
      this.#ingest(node);
    }
  }

  /** One node into every internal structure — shared by constructor and `add`. */
  #ingest(node: NodeDto): void {
    const parentKey = node.parentId ?? null;

    this.#byId.set(node.id, node);

    // Parent→children
    let list = this.#children.get(parentKey);
    if (!list) {
      list = [];
      this.#children.set(parentKey, list);
    }
    list.push(node);

    // Child count
    if (node.parentId) {
      this.#childCount.set(node.parentId, (this.#childCount.get(node.parentId) ?? 0) + 1);
    } else {
      let roots = this.#roots.get(node.kind);
      if (!roots) {
        roots = [];
        this.#roots.set(node.kind, roots);
      }
      roots.push(node);
    }

    // Dependents (inverse of dependsOn). Templates carry the same edge — it
    // becomes the dependency between the issues they produce — so the canvas
    // draws and highlights it in the registry exactly as it does on the board.
    if (node.kind === 'issue' || node.kind === 'template') {
      for (const target of node.dependsOn) {
        (this.#dependents[target] ??= []).push(node.id);
      }
    }
  }

  childrenOf(id: string | null): NodeDto[] {
    return this.#children.get(id) ?? [];
  }

  subtreeIds(id: string): string[] {
    const ids = [id];
    for (const child of this.childrenOf(id)) ids.push(...this.subtreeIds(child.id));
    return ids;
  }

  rootsOf(kind: NodeKind): NodeDto[] {
    return this.#roots.get(kind) ?? [];
  }

  hasChildren(id: string): boolean {
    return (this.#childCount.get(id) ?? 0) > 0;
  }

  dependentsOf(id: string): string[] {
    return this.#dependents[id] ?? [];
  }

  ancestorsOf(id: string): NodeDto[] {
    const chain: NodeDto[] = [];
    const seen = new Set<string>([id]);
    let current = this.#byId.get(id)?.parentId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const parent = this.#byId.get(current);
      if (!parent) break;
      chain.push(parent);
      current = parent.parentId;
    }
    return chain;
  }

  parentOf(id: string): NodeDto | undefined {
    const node = this.#byId.get(id);
    if (!node?.parentId) return undefined;
    return this.#byId.get(node.parentId);
  }

  // ── Incremental maintenance (§1.6) ────────────────────────────

  /** A node just landed in the working copy. */
  add(node: NodeDto): void {
    this.#ingest(node);
  }

  /** A node and its descendants are leaving the working copy. */
  remove(ids: Set<string>): void {
    for (const id of ids) {
      const node = this.#byId.get(id);
      if (!node) continue;

      const parentKey = node.parentId ?? null;

      // Remove from parent→children
      const siblings = this.#children.get(parentKey);
      if (siblings) {
        this.#children.set(
          parentKey,
          siblings.filter((s) => s.id !== id),
        );
      }

      // Decrement child count
      if (parentKey) {
        const count = this.#childCount.get(parentKey) ?? 0;
        if (count <= 1) this.#childCount.delete(parentKey);
        else this.#childCount.set(parentKey, count - 1);
      } else {
        const roots = this.#roots.get(node.kind);
        if (roots) this.#roots.set(node.kind, roots.filter((r) => r.id !== id));
      }

      // Dependents — remove this node from every target's dependents list
      if (node.kind === 'issue' || node.kind === 'template') {
        for (const target of node.dependsOn) {
          const deps = this.#dependents[target];
          if (deps) {
            this.#dependents[target] = deps.filter((d) => d !== id);
            if (this.#dependents[target].length === 0) delete this.#dependents[target];
          }
        }
        // Delete this node's own dependents entry and also purge any
        // reference to it from surviving dependents lists — whether or not
        // `detach` in working.ts told the index about the severing.
        delete this.#dependents[id];
        for (const [target, deps] of Object.entries(this.#dependents)) {
          const filtered = deps.filter((d) => d !== id);
          if (filtered.length === 0) delete this.#dependents[target];
          else if (filtered.length !== deps.length) this.#dependents[target] = filtered;
        }
      }

      // Remove this node's own entries
      this.#children.delete(id);
      this.#childCount.delete(id);
      this.#byId.delete(id);
    }
  }

  /** A node moved to a new parent. */
  reparent(id: string, oldParentId: string | null, newParentId: string | null): void {
    if (oldParentId === newParentId) return;
    const node = this.#byId.get(id);
    if (!node) return;

    // Remove from old parent's children
    const oldSiblings = this.#children.get(oldParentId);
    if (oldSiblings) {
      this.#children.set(
        oldParentId,
        oldSiblings.filter((s) => s.id !== id),
      );
    }
    if (oldParentId) {
      const count = this.#childCount.get(oldParentId) ?? 0;
      if (count <= 1) this.#childCount.delete(oldParentId);
      else this.#childCount.set(oldParentId, count - 1);
    }
    if (oldParentId === null) {
      const roots = this.#roots.get(node.kind);
      if (roots) this.#roots.set(node.kind, roots.filter((r) => r.id !== id));
    }

    // Add to new parent's children
    let newList = this.#children.get(newParentId);
    if (!newList) {
      newList = [];
      this.#children.set(newParentId, newList);
    }
    newList.push(node);
    if (newParentId) {
      this.#childCount.set(newParentId, (this.#childCount.get(newParentId) ?? 0) + 1);
    }
    if (newParentId === null) {
      let roots = this.#roots.get(node.kind);
      if (!roots) {
        roots = [];
        this.#roots.set(node.kind, roots);
      }
      roots.push(node);
    }
  }

  /** The `dependsOn` list of one node was replaced wholesale. */
  setDependsOn(id: string, oldIds: string[], newIds: string[]): void {
    for (const target of oldIds) {
      const deps = this.#dependents[target];
      if (deps) {
        this.#dependents[target] = deps.filter((d) => d !== id);
        if (this.#dependents[target].length === 0) delete this.#dependents[target];
      }
    }
    for (const target of newIds) {
      (this.#dependents[target] ??= []).push(id);
    }
  }
}

/** Build the index from a `WorkingNodes` record in one pass. */
export function buildIndex(nodes: WorkingNodes): NodeIndexImpl {
  return new NodeIndexImpl(nodes);
}
