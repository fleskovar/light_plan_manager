import type { ConfigDto, NodeDto, NodeKind } from '$shared';
import { childTypes } from '$lib/board/links.js';
import type { WorkingNodes } from '$lib/board/working.js';
import { ancestorIds } from './model.js';

/**
 * The questions that edit mode asks about the active item.
 *
 * Edit mode can make one document the active item. The canvas then draws only
 * the documents inside it, and a new item becomes its child. These functions
 * answer the questions around that: which documents can be entered, what the
 * breadcrumb bar shows, which types a new item can take, and which item to
 * activate so that a given document is on the canvas.
 */

/** The registry's container type. @see src/core/model/types.ts */
const TEMPLATE_FOLDER = 'folder';

/** One step of the breadcrumb bar. A null id is the whole view. */
export interface Crumb {
  id: string | null;
  label: string;
  typeLabel: string;
}

/** True when `id` is a descendant of `scope`. Every id is inside a null scope. */
export function isInside(nodes: WorkingNodes, id: string, scope: string | null): boolean {
  if (scope === null) return true;
  return ancestorIds(nodes, id).includes(scope);
}

/**
 * The types that a new child of `parent` can take, in hierarchy order. A null
 * parent gives the types of the top level of `kind`.
 *
 * In the registry a folder groups templates and never sits inside one, so a
 * folder is offered only under a folder or at the top level.
 * @see placementProblem in src/core/board/registry.ts
 */
export function creatableTypes(config: ConfigDto, kind: NodeKind, parent: NodeDto | null): string[] {
  if (!parent) return config.hierarchy[kind][0] ?? [];
  return childTypes(config, parent.kind, parent.depth).filter(
    (type) => type !== TEMPLATE_FOLDER || parent.type === TEMPLATE_FOLDER,
  );
}

/** True when the hierarchy allows children under `node`, so edit mode can enter it. */
export function canEnter(config: ConfigDto, node: NodeDto | undefined): boolean {
  if (!node || (node.kind !== 'issue' && node.kind !== 'template')) return false;
  return creatableTypes(config, node.kind, node).length > 0;
}

/**
 * The type a new item takes: the type chosen for its depth when the hierarchy
 * still allows it, else the first allowed type. Null when no type is allowed.
 */
export function chosenType(
  allowed: string[],
  depth: number,
  chosen: Record<number, string>,
): string | null {
  const pick = chosen[depth];
  if (pick && allowed.includes(pick)) return pick;
  return allowed[0] ?? null;
}

/** Hierarchy depth of a new child of `parent`. A null parent gives 0. */
export function childDepth(parent: NodeDto | null): number {
  return parent ? parent.depth + 1 : 0;
}

/**
 * The steps from the whole view to `activeId`: the view first, then each
 * ancestor on the board, outermost first, then the active item.
 */
export function breadcrumb(
  nodes: WorkingNodes,
  config: ConfigDto,
  activeId: string | null,
  viewName: string,
): Crumb[] {
  const root: Crumb = { id: null, label: viewName, typeLabel: 'View' };
  if (!activeId || !nodes[activeId]) return [root];
  const chain = [...ancestorIds(nodes, activeId).reverse(), activeId];
  return [
    root,
    ...chain.map((id) => {
      const node = nodes[id];
      return {
        id,
        label: node?.title ?? id,
        typeLabel: config.types[node?.type ?? '']?.label ?? '',
      };
    }),
  ];
}

/**
 * The active item to use so that `id` is on the canvas. The current scope is
 * kept when it already holds `id`. Otherwise the parent of `id` becomes the
 * active item, so `id` is drawn without a frame around it.
 */
export function scopeShowing(
  nodes: WorkingNodes,
  id: string,
  current: string | null,
): string | null {
  if (isInside(nodes, id, current)) return current;
  return nodes[id]?.parentId ?? null;
}
