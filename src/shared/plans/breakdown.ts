import type { Change, NodePatch } from '../changes.js';
import type { NodeKind } from '../model.js';
import type { BoardView, IdFactory } from './reading.js';
import {
  childrenOf,
  dependentsOf,
  subtreeIds,
  typeAtDepth,
  wouldCycle,
} from './reading.js';

// -- planning --------------------------------------------------------------

/** A planner either produces changes or explains why it cannot. */
export type Plan =
  | { ok: true; changes: Change[]; created: string[] }
  | { ok: false; error: string; details?: string[] };

const fail = (error: string, details?: string[]): Plan => ({ ok: false, error, details });

export { fail };

function create(id: string, nodeKind: NodeKind, patch: NodePatch): Change {
  return { kind: 'create', id, nodeKind, patch };
}

function update(view: BoardView, id: string, patch: NodePatch): Change {
  return { kind: 'update', id, nodeKind: view.nodes[id]?.kind ?? 'issue', patch };
}

export { create, update };

export interface BreakdownOptions {
  /** How many pieces to split into. */
  count: number;
  /** `children` nests the pieces under the original; `replace` swaps it out. */
  mode: 'children' | 'replace';
  /** Titles for the pieces; a short list is padded with "<title> (n)". */
  titles?: string[];
  /** Chain the pieces so each depends on the one before it. Defaults to true. */
  chain?: boolean;
  /** Divide this attribute's value evenly across the pieces. */
  splitAttribute?: string;
}

/**
 * Split an issue into `count` pieces.
 *
 * The rewiring is the reason this is worth automating: whichever mode is
 * chosen, whatever blocked the original blocks the first piece, and whatever
 * waited on it waits on the last. A 15-point story becomes five 3-point ones
 * without touching a single edge by hand.
 */
export function planBreakdown(
  view: BoardView,
  nextId: IdFactory,
  id: string,
  options: BreakdownOptions,
): Plan {
  const issue = view.nodes[id];
  if (!issue) return fail(`No issue with id "${id}"`);
  if (issue.kind !== 'issue') return fail(`${id} is a ${issue.kind}; only issues can be split`);
  if (options.count < 1) return fail('A breakdown needs at least one piece');

  const nested = options.mode === 'children';
  const depth = nested ? issue.depth + 1 : issue.depth;
  const type = typeAtDepth(view.config, 'issue', depth, issue.type);
  if (!type) {
    const label = view.config.types[issue.type]?.label ?? issue.type;
    return fail(
      nested
        ? `There is no issue type below "${label}"`
        : `"${label}" has no level in the hierarchy`,
      nested ? ['Use the replacing mode, which keeps the pieces at this level.'] : undefined,
    );
  }

  // Dividing the effort only makes sense when the pieces can hold it: a story
  // measured in points may break into sub-tasks measured in hours, and writing
  // `story_points` onto one of those is something the board would reject.
  const attribute = options.splitAttribute;
  const raw = attribute ? issue.attributes[attribute] : undefined;
  const declared = attribute
    ? (view.config.types[type]?.attributes ?? []).some((entry) => entry.name === attribute)
    : false;
  const share =
    declared && typeof raw === 'number' ? Math.max(1, Math.round(raw / options.count)) : null;

  const chain = options.chain !== false;
  const changes: Change[] = [];
  const created: string[] = [];

  for (let index = 0; index < options.count; index += 1) {
    const title = options.titles?.[index]?.trim() || `${issue.title} (${index + 1})`;
    const previous = created.at(-1);
    // The first piece stands where the original stood; the rest queue behind it.
    const dependsOn = previous && chain ? [previous] : nested ? [] : [...issue.dependsOn];
    const pieceId = nextId();

    changes.push(
      create(pieceId, 'issue', {
        type,
        title,
        parentId: nested ? id : issue.parentId,
        status: issue.status,
        assignee: issue.assignee,
        period: issue.period,
        dependsOn,
        ...(share !== null ? { attributes: { [attribute!]: share } } : {}),
      }),
    );
    created.push(pieceId);
  }

  if (!nested) {
    // The original is going away, so its downstream edges move to the last piece.
    const last = created.at(-1)!;
    for (const downstream of dependentsOf(view, id)) {
      if (downstream.kind !== 'issue') continue;
      changes.push(
        update(view, downstream.id, {
          dependsOn: [...downstream.dependsOn.filter((dep) => dep !== id), last],
        }),
      );
    }
    changes.push({ kind: 'delete', id, nodeKind: 'issue' });
  }

  return { ok: true, changes, created };
}

/**
 * Copy documents and everything under them.
 *
 * Dependencies that ran *between* the copied nodes are kept and repointed at
 * the copies; those that left the selection are dropped, because a duplicated
 * structure should stand on its own rather than re-block whatever the original
 * blocked.
 */
export function planDuplicate(view: BoardView, nextId: IdFactory, ids: string[]): Plan {
  const missing = ids.filter((id) => !view.nodes[id]);
  if (missing.length) return fail(`No document with id "${missing[0]}"`);

  // Copying a parent already copies its children; doing both would duplicate them.
  const roots = ids.filter(
    (id) => !ids.some((other) => other !== id && subtreeIds(view, other).includes(id)),
  );

  const changes: Change[] = [];
  const idMap: Record<string, string> = {};

  const copy = (sourceId: string, parentId: string | null): void => {
    const node = view.nodes[sourceId];
    if (!node) return;
    const cloneId = nextId();
    idMap[sourceId] = cloneId;

    changes.push(
      create(cloneId, node.kind, {
        type: node.type,
        title: `${node.title} (copy)`,
        parentId,
        body: node.body,
        attributes: { ...node.attributes },
        ...(node.kind === 'issue' ? { status: node.status } : {}),
        ...(node.kind === 'period' ? { starts: node.starts, ends: node.ends } : {}),
        ...(node.kind === 'resource' ? { capacity: node.capacity } : {}),
      }),
    );
    for (const child of childrenOf(view, sourceId)) copy(child.id, cloneId);
  };

  for (const id of roots) copy(id, view.nodes[id]?.parentId ?? null);

  for (const [sourceId, cloneId] of Object.entries(idMap)) {
    const source = view.nodes[sourceId];
    if (source?.kind !== 'issue') continue;
    const dependsOn = source.dependsOn
      .map((dep) => idMap[dep])
      .filter((dep): dep is string => Boolean(dep));
    if (dependsOn.length) changes.push(update(view, cloneId, { dependsOn }));
  }

  return { ok: true, changes, created: Object.values(idMap) };
}

export interface InsertOptions {
  /** The dependency to insert into: `target` currently depends on `source`. */
  source: string;
  target: string;
  /** Move this existing issue into the edge. */
  issueId?: string;
  /** Or create one; defaults to the upstream issue's type and parent. */
  type?: string;
  title?: string;
}

/**
 * Put an issue between two others, replacing the edge that joined them.
 *
 * This is "drag a node onto an edge" and "right-click an edge, New...": either
 * an existing issue moves into the dependency, or a fresh one is created at the
 * upstream node's level.
 */
export function planInsert(view: BoardView, nextId: IdFactory, options: InsertOptions): Plan {
  const source = view.nodes[options.source];
  const target = view.nodes[options.target];
  if (!source) return fail(`No issue with id "${options.source}"`);
  if (!target) return fail(`No issue with id "${options.target}"`);
  if (target.kind !== 'issue' || !target.dependsOn.includes(source.id)) {
    return fail(`${options.target} does not depend on ${options.source}`);
  }

  const changes: Change[] = [];
  let middleId: string;
  let middleDependsOn: string[];

  if (options.issueId) {
    const middle = view.nodes[options.issueId];
    if (!middle) return fail(`No issue with id "${options.issueId}"`);
    if (middle.kind !== 'issue') return fail(`${options.issueId} is a ${middle.kind}`);
    if (middle.id === source.id || middle.id === target.id) {
      return fail('An issue cannot be inserted into its own dependency');
    }
    const cycle = wouldCycle(view, middle.id, source.id);
    if (cycle) return fail('That would create a cycle', [cycle.join(' -> ')]);

    middleId = middle.id;
    middleDependsOn = middle.dependsOn.includes(source.id)
      ? middle.dependsOn
      : [...middle.dependsOn, source.id];
    changes.push(update(view, middleId, { dependsOn: middleDependsOn }));
  } else {
    const type = options.type ?? source.type;
    if (!view.config.types[type]) return fail(`Unknown issue type "${type}"`);
    middleId = nextId();
    changes.push(
      create(middleId, 'issue', {
        type,
        title: options.title ?? 'New step',
        parentId: source.parentId,
        dependsOn: [source.id],
      }),
    );
  }

  // The old edge is replaced, not added to: source -> target becomes
  // source -> middle -> target.
  changes.push(
    update(view, target.id, {
      dependsOn: [...target.dependsOn.filter((dep) => dep !== source.id), middleId],
    }),
  );

  return { ok: true, changes, created: options.issueId ? [] : [middleId] };
}
