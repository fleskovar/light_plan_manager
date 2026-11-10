import { GROUP_HEADER, GROUP_PADDING } from './model/constants.js';

/**
 * Push and grow: the geometry of a plain drag or a resize on the canvas.
 *
 * `reshape` receives the boxes of the canvas and the ids of the nodes that the
 * reader holds. It returns new boxes in which:
 *
 * 1. No sibling overlaps a held node. A sibling that overlaps one moves out
 *    along the shortest of the four directions, to `PUSH_GAP` from it. A moved
 *    sibling can push the next sibling in the same way.
 * 2. Each frame holds its children. A frame grows to the right and down to
 *    `GROUP_PADDING` past its last child. It grows to the left and up so that
 *    its first child starts at `GROUP_PADDING` and at `GROUP_HEADER`. The frame
 *    then moves, and its children move back by the same amount, so that no
 *    child moves on screen.
 * 3. A frame that grew or moved counts as held in its own parent. Steps 1 and
 *    2 repeat there, up to the top level of the canvas.
 *
 * A frame never gets smaller. The caller starts each step of a gesture from
 * the boxes that the gesture started with, so a frame returns to its first
 * size, and a pushed node to its first place, when the held node moves back.
 *
 * Positions are relative to the parent, as SvelteFlow stores them. A node
 * whose `parentId` is absent from `boxes` counts as top level.
 */

/** The space that a push leaves between two nodes, in canvas pixels. */
export const PUSH_GAP = 24;

export interface Box {
  id: string;
  parentId?: string;
  position: { x: number; y: number };
  width: number;
  height: number;
}

export function reshape<T extends Box>(boxes: readonly T[], held: ReadonlySet<string>): T[] {
  const byId = new Map<string, T>(
    boxes.map((box) => [box.id, { ...box, position: { ...box.position } }]),
  );
  const containerOf = (box: Box): string | null =>
    box.parentId && byId.has(box.parentId) ? box.parentId : null;

  const childrenOf = new Map<string | null, T[]>();
  for (const box of byId.values()) {
    const container = containerOf(box);
    childrenOf.set(container, [...(childrenOf.get(container) ?? []), box]);
  }

  const depthOf = (id: string | null): number => {
    let depth = -1;
    const seen = new Set<string>();
    let current = id;
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      depth += 1;
      current = containerOf(byId.get(current)!);
    }
    return depth;
  };

  const changed = new Set([...held].filter((id) => byId.has(id)));
  const pending = new Set([...changed].map((id) => containerOf(byId.get(id)!)));

  // The deepest container goes first, because a frame that grows changes the
  // level above it, and never the levels below it.
  while (pending.size) {
    const container = [...pending].sort((a, b) => depthOf(b) - depthOf(a))[0]!;
    pending.delete(container);
    const children = childrenOf.get(container) ?? [];
    pushApart(
      children,
      children.filter((child) => changed.has(child.id)),
    );
    if (container === null) continue;
    const frame = byId.get(container)!;
    if (grow(frame, children)) {
      changed.add(frame.id);
      pending.add(containerOf(frame));
    }
  }

  return boxes.map((box) => byId.get(box.id)!);
}

/**
 * Move the siblings that overlap a mover. The movers never move. A sibling
 * that moved becomes a mover for the siblings that it now overlaps.
 */
function pushApart(siblings: Box[], movers: Box[]): void {
  const fixed = new Set(movers.map((mover) => mover.id));
  const queue = [...movers];
  // Each push moves a sibling clear of one mover. The limit stops a loop
  // between siblings that a frame packs too tightly to separate.
  let pushes = siblings.length * siblings.length + 16;
  while (queue.length && pushes > 0) {
    const mover = queue.shift()!;
    for (const sibling of siblings) {
      if (sibling === mover || fixed.has(sibling.id)) continue;
      const shift = separation(mover, sibling);
      if (!shift) continue;
      sibling.position.x += shift.x;
      sibling.position.y += shift.y;
      queue.push(sibling);
      pushes -= 1;
    }
  }
}

/**
 * The shortest move that puts `other` at `PUSH_GAP` from `mover`, or null when
 * `other` is already that far away. On a tie, right wins over down, down over
 * left, and left over up.
 */
export function separation(mover: Box, other: Box): { x: number; y: number } | null {
  const near =
    other.position.x < mover.position.x + mover.width + PUSH_GAP &&
    mover.position.x < other.position.x + other.width + PUSH_GAP &&
    other.position.y < mover.position.y + mover.height + PUSH_GAP &&
    mover.position.y < other.position.y + other.height + PUSH_GAP;
  if (!near) return null;

  const right = mover.position.x + mover.width + PUSH_GAP - other.position.x;
  const down = mover.position.y + mover.height + PUSH_GAP - other.position.y;
  const left = other.position.x + other.width + PUSH_GAP - mover.position.x;
  const up = other.position.y + other.height + PUSH_GAP - mover.position.y;
  const shortest = Math.min(right, down, left, up);
  if (shortest === right) return { x: right, y: 0 };
  if (shortest === down) return { x: 0, y: down };
  if (shortest === left) return { x: -left, y: 0 };
  return { x: 0, y: -up };
}

/** Grow `frame` around `children`. Returns true when the frame moved or grew. */
function grow(frame: Box, children: Box[]): boolean {
  if (!children.length) return false;
  const minX = Math.min(...children.map((child) => child.position.x));
  const minY = Math.min(...children.map((child) => child.position.y));
  const dx = minX < GROUP_PADDING ? GROUP_PADDING - minX : 0;
  const dy = minY < GROUP_HEADER ? GROUP_HEADER - minY : 0;
  if (dx || dy) {
    frame.position.x -= dx;
    frame.position.y -= dy;
    frame.width += dx;
    frame.height += dy;
    for (const child of children) {
      child.position.x += dx;
      child.position.y += dy;
    }
  }

  const reachX = Math.max(...children.map((child) => child.position.x + child.width));
  const reachY = Math.max(...children.map((child) => child.position.y + child.height));
  const width = Math.max(frame.width, reachX + GROUP_PADDING);
  const height = Math.max(frame.height, reachY + GROUP_PADDING);
  const grew = width !== frame.width || height !== frame.height;
  frame.width = width;
  frame.height = height;
  return grew || dx !== 0 || dy !== 0;
}
