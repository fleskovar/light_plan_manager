import type { ConfigDto, LevelLayout, NodeKind, NodeLayout, TypeDisplay } from '$shared';
import type { WorkingNodes } from './working.js';

/**
 * The detail level of a canvas: the rules that the editor's `Workspace` and the
 * viewer's `ViewerBoard` share.
 *
 * A level is a depth of the hierarchy, for example 1 for the features of a
 * board with the levels epic, feature and user story. The view key `level`
 * stores it. A node at that depth or deeper folds its children into itself.
 * The canvas then draws each dependency between the folded children on the
 * nodes that hold them (`representative` in `visibleTree`). A null level folds
 * nothing.
 *
 * The key `collapsed` of a layout entry overrides the level for one node. The
 * chevron of a node writes it, so a reader can open one feature on a canvas
 * that shows features.
 *
 * Each level keeps its own arrangement. When the reader leaves a level,
 * `switchLevel` stores the positions and the `collapsed` keys of that level in
 * the view key `levelLayouts`, and restores those of the level the reader goes
 * to.
 */

/** The template registry's folder type. @see src/core/model/types.ts */
const TEMPLATE_FOLDER = 'folder';

/** One step of the level bar. */
export interface HierarchyLevel {
  /** The depth of the level in the hierarchy, 0 at the top. */
  depth: number;
  /** The types at this depth, in hierarchy order. */
  types: string[];
  /** The labels of `types`, joined with " / ". */
  label: string;
  /** The members of the view at this depth. */
  members: number;
  /** True when the view draws every type of this level as a badge. */
  badged: boolean;
}

/**
 * The levels of the hierarchy of `kind`, top first. A registry folder sits at
 * every depth, so it does not name a level.
 */
export function hierarchyLevels(
  config: ConfigDto,
  kind: NodeKind,
  nodes: WorkingNodes,
  members: readonly string[],
  display: Readonly<Record<string, TypeDisplay>>,
): HierarchyLevel[] {
  const counts = new Map<number, number>();
  for (const id of members) {
    const node = nodes[id];
    if (node) counts.set(node.depth, (counts.get(node.depth) ?? 0) + 1);
  }
  return (config.hierarchy[kind] ?? []).map((all, depth) => {
    const named = all.filter((type) => type !== TEMPLATE_FOLDER);
    const types = named.length ? named : all;
    return {
      depth,
      types,
      label: types.map((type) => config.types[type]?.label ?? type).join(' / '),
      members: counts.get(depth) ?? 0,
      badged: types.length > 0 && types.every((type) => display[type] === 'badge'),
    };
  });
}

/**
 * The level that a view stores, made valid for a hierarchy of `levels`
 * levels. A missing level, a level that is not an integer and the deepest level
 * all give null, because those levels fold nothing.
 */
export function clampLevel(level: number | null | undefined, levels: number): number | null {
  if (level === null || level === undefined || !Number.isInteger(level) || level < 0) return null;
  return level >= levels - 1 ? null : level;
}

/**
 * True when a node at `depth` folds its children. The key `collapsed` of the
 * layout entry decides when it is present. Otherwise the level decides.
 */
export function isFolded(
  entry: Pick<NodeLayout, 'collapsed'> | undefined,
  depth: number,
  level: number | null,
): boolean {
  if (entry?.collapsed !== undefined) return entry.collapsed;
  return level !== null && depth >= level;
}

export type { LevelLayout };

/** Stored arrangements, by level key (`levelKey`), then by node id. */
export type LevelLayouts = Record<string, Record<string, LevelLayout>>;

/** The key of `level` in `LevelLayouts`. Null, which folds nothing, is `all`. */
export function levelKey(level: number | null): string {
  return level === null ? 'all' : String(level);
}

export interface LevelSwitch {
  layout: Record<string, NodeLayout>;
  levelLayouts: LevelLayouts;
  /**
   * True when `levelLayouts` held an arrangement for the new level. False
   * means that the canvas must lay the graph out again.
   */
  restored: boolean;
}

/**
 * Leave level `from` for level `to`.
 *
 * 1. The position and the key `collapsed` of each entry of `layout` go into
 *    `levelLayouts` under the key of `from`.
 * 2. When `levelLayouts` holds an arrangement for `to`, its positions and its
 *    `collapsed` keys replace those of `layout`, and the stored copy is
 *    removed, because `layout` holds it now.
 * 3. Otherwise every `collapsed` key is removed, so each node follows the new
 *    level.
 *
 * The sizes in `layout` belong to no level, so they stay. The inputs are not
 * changed.
 */
export function switchLevel(
  layout: Readonly<Record<string, NodeLayout>>,
  levelLayouts: Readonly<LevelLayouts>,
  from: number | null,
  to: number | null,
): LevelSwitch {
  const left: Record<string, LevelLayout> = {};
  for (const [id, entry] of Object.entries(layout)) {
    left[id] = {
      x: entry.x,
      y: entry.y,
      ...(entry.collapsed !== undefined ? { collapsed: entry.collapsed } : {}),
    };
  }

  const stored = levelLayouts[levelKey(to)];
  const next: Record<string, NodeLayout> = {};
  for (const [id, entry] of Object.entries(layout)) {
    const { collapsed: _collapsed, ...kept } = entry;
    const saved = stored?.[id];
    next[id] = saved ? { ...kept, ...saved } : kept;
  }
  for (const [id, saved] of Object.entries(stored ?? {})) {
    if (!next[id]) next[id] = { ...saved };
  }

  const others = Object.fromEntries(
    Object.entries(levelLayouts).filter(([key]) => key !== levelKey(to)),
  );
  return {
    layout: next,
    levelLayouts: { ...others, [levelKey(from)]: left },
    restored: stored !== undefined,
  };
}
