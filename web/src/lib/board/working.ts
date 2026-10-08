import type { AttributeDto, Change, ConfigDto, NodeDto, NodeKind, TypeDto } from '$shared';
import type { NodeIndexImpl } from './index.js';
import { applyStatusRollup } from './rollup.js';

/**
 * The working board: the pulled snapshot with the view's pending changes laid
 * over it.
 *
 * There is one applier, used both when the user edits something and when a
 * saved view is reopened and its queue replayed. That is what keeps "what I see"
 * and "what will be pushed" from drifting apart.
 */
export type WorkingNodes = Record<string, NodeDto>;

export function initialValue(attribute: AttributeDto): unknown {
  if (attribute.default !== undefined) return attribute.default;
  return attribute.type === 'array' ? [] : null;
}

export function initialAttributes(type: TypeDto | undefined): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const attribute of type?.attributes ?? []) attributes[attribute.name] = initialValue(attribute);
  return attributes;
}

function blankNode(config: ConfigDto, id: string, nodeKind: NodeKind, typeName: string): NodeDto {
  const type = config.types[typeName];
  const base = {
    id,
    type: typeName,
    title: 'Untitled',
    body: type ? '' : '',
    parentId: null,
    depth: type?.depth ?? 0,
    attributes: initialAttributes(type),
  };
  if (nodeKind === 'period') return { ...base, kind: 'period', squad: null };
  if (nodeKind === 'resource') {
    return { ...base, kind: 'resource', capacity: 1, covers: [], generic: type?.generic ?? false };
  }
  if (nodeKind === 'squad') return { ...base, kind: 'squad', members: [] };
  if (nodeKind === 'template') {
    return {
      ...base,
      kind: 'template',
      description: '',
      params: {},
      // Whether it is a root depends on the parent, which `patchNode` has not
      // applied yet; `resettleTemplate` settles it once the tree is known.
      root: true,
      dependsOn: [],
      relatesTo: [],
      relatedFiles: [],
    };
  }
  return {
    ...base,
    kind: 'issue',
    status: config.defaultStatus,
    assignee: null,
    period: null,
    flag: null,
    dependsOn: [],
    relatesTo: [],
    relatedFiles: [],
  };
}

/** Apply a patch to a node, in place, ignoring fields its kind does not have. */
function patchNode(node: NodeDto, change: Extract<Change, { kind: 'create' | 'update' }>): void {
  const { patch } = change;
  if (patch.title !== undefined) node.title = patch.title;
  if (patch.body !== undefined) node.body = patch.body;
  if (patch.parentId !== undefined) node.parentId = patch.parentId;
  if (patch.attributes) node.attributes = { ...node.attributes, ...patch.attributes };

  if (node.kind === 'issue') {
    if (patch.status !== undefined) node.status = patch.status;
    if (patch.assignee !== undefined) node.assignee = patch.assignee;
    if (patch.period !== undefined) node.period = patch.period;
    if (patch.dependsOn !== undefined) node.dependsOn = [...patch.dependsOn];
    if (patch.relatesTo !== undefined) node.relatesTo = [...patch.relatesTo];
    if (patch.relatedFiles !== undefined) node.relatedFiles = [...patch.relatedFiles];
    // `flag` is not patchable: it is written straight through, never queued.
  } else if (node.kind === 'period') {
    if (patch.starts !== undefined) node.starts = patch.starts;
    if (patch.ends !== undefined) node.ends = patch.ends;
    // null is "back on the dates", which is the absent field rather than false.
    if (patch.active !== undefined) node.active = patch.active ?? undefined;
    if (patch.squad !== undefined) node.squad = patch.squad;
  } else if (node.kind === 'resource') {
    if (patch.capacity !== undefined) node.capacity = patch.capacity;
    if (patch.covers !== undefined) node.covers = [...patch.covers];
  } else if (node.kind === 'template') {
    if (patch.description !== undefined) node.description = patch.description;
    if (patch.params !== undefined) node.params = { ...patch.params };
    if (patch.dependsOn !== undefined) node.dependsOn = [...patch.dependsOn];
    if (patch.relatesTo !== undefined) node.relatesTo = [...patch.relatesTo];
    if (patch.relatedFiles !== undefined) node.relatedFiles = [...patch.relatedFiles];
  } else {
    if (patch.members !== undefined) node.members = [...patch.members];
  }
}

/** The registry's container type. @see src/core/model/types.ts */
const TEMPLATE_FOLDER = 'folder';

/** Retyping moves a node to the depth of its new type; so does reparenting. */
function resettle(nodes: WorkingNodes, node: NodeDto, config: ConfigDto): void {
  const parent = node.parentId ? nodes[node.parentId] : undefined;
  node.depth = parent ? parent.depth + 1 : (config.types[node.type]?.depth ?? 0);
  // `root` is derived from the parent on the way in (`sync/dto.ts`), so it has
  // to be derived again here or a template dragged into a feature would still
  // claim to be instantiable until the next pull.
  if (node.kind === 'template') {
    node.root =
      node.type !== TEMPLATE_FOLDER && (!parent || parent.type === TEMPLATE_FOLDER);
  }
}

export function descendantsOf(
  nodes: WorkingNodes,
  id: string,
  index?: NodeIndexImpl,
): string[] {
  if (index) return index.subtreeIds(id).filter((entry) => entry !== id);
  const found: string[] = [];
  const walk = (parentId: string): void => {
    for (const node of Object.values(nodes)) {
      if (node.parentId !== parentId) continue;
      found.push(node.id);
      walk(node.id);
    }
  };
  walk(id);
  return found;
}

/** Forget an id everywhere it is referenced, the way `removeNode` does on disk. */
function detach(nodes: WorkingNodes, gone: Set<string>): void {
  for (const node of Object.values(nodes)) {
    if (node.kind === 'issue') {
      node.dependsOn = node.dependsOn.filter((id) => !gone.has(id));
      node.relatesTo = node.relatesTo.filter((id) => !gone.has(id));
      if (node.assignee && gone.has(node.assignee)) node.assignee = null;
      if (node.period && gone.has(node.period)) node.period = null;
    } else if (node.kind === 'resource') {
      node.covers = node.covers.filter((id) => !gone.has(id));
    } else if (node.kind === 'template') {
      node.dependsOn = node.dependsOn.filter((id) => !gone.has(id));
      node.relatesTo = node.relatesTo.filter((id) => !gone.has(id));
    }
  }
}

export function applyChange(
  nodes: WorkingNodes,
  change: Change,
  config: ConfigDto,
  index?: NodeIndexImpl,
): void {
  if (change.kind === 'create') {
    const node = blankNode(config, change.id, change.nodeKind, change.patch.type ?? '');
    nodes[change.id] = node;
    patchNode(node, change);
    resettle(nodes, node, config);
    index?.add(node);
    // A new issue inside a container that was finished reopens it, exactly as
    // it will when this change is pushed.
    if (change.patch.parentId) applyStatusRollup(nodes, node.id, config, index);
    return;
  }

  if (change.kind === 'update') {
    const node = nodes[change.id];
    if (!node) return;

    // Snapshot structural fields before patching, for index maintenance.
    const oldParentId = change.patch.parentId !== undefined ? node.parentId : undefined;
    const oldDependsOn =
      node.kind === 'issue' && change.patch.dependsOn !== undefined
        ? [...node.dependsOn]
        : undefined;

    if (change.patch.type !== undefined && change.patch.type !== node.type) {
      const next = config.types[change.patch.type];
      node.type = change.patch.type;
      // Attributes the new type does not declare fall away, as they do on disk.
      const kept: Record<string, unknown> = initialAttributes(next);
      for (const name of Object.keys(kept)) {
        if (name in node.attributes) kept[name] = node.attributes[name];
      }
      node.attributes = kept;
    }
    patchNode(node, change);
    resettle(nodes, node, config);

    // Maintain the index for structural changes.
    if (index) {
      if (oldParentId !== undefined && change.patch.parentId !== oldParentId) {
        index.reparent(change.id, oldParentId, change.patch.parentId!);
      }
      if (oldDependsOn !== undefined) {
        index.setDependsOn(change.id, oldDependsOn, (node as Extract<NodeDto, { kind: 'issue' }>).dependsOn);
      }
    }

    // A container's status comes from the work inside it, so a status change —
    // or a move into a different container — carries the ancestors with it, the
    // way it will when this change is pushed.
    if (change.patch.status !== undefined || change.patch.parentId !== undefined) {
      applyStatusRollup(nodes, change.id, config, index);
    }
    return;
  }

  const gone = new Set([change.id, ...descendantsOf(nodes, change.id, index)]);
  index?.remove(gone);
  for (const id of gone) delete nodes[id];
  detach(nodes, gone);
}

/**
 * Copy the pulled documents so edits never write through to the snapshot.
 *
 * The nodes handed in must be the plain DTOs the wire delivered — both stores
 * hold their board in `$state.raw` for exactly this reason, because a deeply
 * proxied object is not structured-cloneable.
 */
export function baseline(nodes: NodeDto[]): WorkingNodes {
  const working: WorkingNodes = {};
  for (const node of nodes) working[node.id] = structuredClone(node);
  return working;
}

/** A snapshot plus a queue of changes: what the user is actually looking at. */
export function replay(nodes: NodeDto[], changes: Change[], config: ConfigDto): WorkingNodes {
  const working = baseline(nodes);
  for (const change of changes) applyChange(working, change, config);
  return working;
}
