import type { ConfigDto, NodePatch, ResourceDto } from '$shared';
import { initialAttributes, type WorkingNodes } from '$lib/board/working.js';
import { createNode, editNode } from '$lib/workspace/mutations.js';
import type { Workspace } from '$lib/workspace/workspace.svelte.js';

/**
 * A person or pool somebody is still describing.
 *
 * Adding a resource used to create it first and open the editor on it second,
 * so the create was queued before anybody had typed a name — and the push that
 * follows every edit moments later gave the document its real id, which left
 * the editor pointing at a temporary id that no longer existed. The draft is
 * the other order: the form edits this plain object, and nothing reaches the
 * queue until the reader presses Create. Closing the form creates nothing.
 */
export interface ResourceDraft {
  type: string;
  title: string;
  parentId: string | null;
  capacity: number;
  covers: string[];
  /** Only the attributes somebody set; the rest keep the type's defaults. */
  attributes: Record<string, unknown>;
  body: string;
  /**
   * People who will take work from this pool once it exists. Coverage is a
   * forward edge stored on *their* documents, so these become edits to them.
   */
  coveredBy: string[];
}

/** The id the preview carries. It is never queued, so it never meets the board. */
export const DRAFT_ID = 'draft:resource';

export function newResourceDraft(type: string): ResourceDraft {
  return {
    type,
    title: '',
    parentId: null,
    capacity: 1,
    covers: [],
    attributes: {},
    body: '',
    coveredBy: [],
  };
}

/** The draft as the resource it will become, for the form to read. */
export function draftNode(draft: ResourceDraft, nodes: WorkingNodes, config: ConfigDto): ResourceDto {
  const type = config.types[draft.type];
  const parent = draft.parentId ? nodes[draft.parentId] : undefined;
  return {
    kind: 'resource',
    id: DRAFT_ID,
    type: draft.type,
    title: draft.title,
    body: draft.body,
    parentId: draft.parentId,
    depth: parent ? parent.depth + 1 : (type?.depth ?? 0),
    attributes: { ...initialAttributes(type), ...draft.attributes },
    capacity: draft.capacity,
    covers: draft.covers,
    generic: type?.generic ?? false,
  };
}

/**
 * Apply one form edit to the draft, the way the working copy applies a patch
 * to a document — including what a change of type takes with it.
 */
export function editDraft(
  draft: ResourceDraft,
  patch: NodePatch,
  nodes: WorkingNodes,
  config: ConfigDto,
): ResourceDraft {
  let next: ResourceDraft = {
    ...draft,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.body !== undefined ? { body: patch.body } : {}),
    ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
    ...(patch.capacity !== undefined ? { capacity: patch.capacity } : {}),
    ...(patch.covers !== undefined ? { covers: [...patch.covers] } : {}),
    ...(patch.attributes ? { attributes: { ...draft.attributes, ...patch.attributes } } : {}),
  };
  if (patch.type !== undefined && patch.type !== draft.type) next = retype(next, patch.type, nodes, config);
  return next;
}

/**
 * A new type keeps what still fits it: attributes it declares, a team at the
 * level above it, and coverage in the direction it has — a person covers pools
 * and a pool is covered by people, so switching between them drops the other.
 */
function retype(
  draft: ResourceDraft,
  typeName: string,
  nodes: WorkingNodes,
  config: ConfigDto,
): ResourceDraft {
  const type = config.types[typeName];
  const declared = new Set((type?.attributes ?? []).map((attribute) => attribute.name));
  const parent = draft.parentId ? nodes[draft.parentId] : undefined;
  const generic = type?.generic ?? false;
  return {
    ...draft,
    type: typeName,
    attributes: Object.fromEntries(
      Object.entries(draft.attributes).filter(([name]) => declared.has(name)),
    ),
    parentId: parent && parent.depth === (type?.depth ?? 0) - 1 ? parent.id : null,
    covers: generic ? [] : draft.covers,
    coveredBy: generic ? draft.coveredBy : [],
  };
}

export function toggleDraftCoverer(draft: ResourceDraft, id: string, on: boolean): ResourceDraft {
  const rest = draft.coveredBy.filter((entry) => entry !== id);
  return { ...draft, coveredBy: on ? [...rest, id] : rest };
}

/** A draft is worth creating once it has a name. */
export function canCreate(draft: ResourceDraft): boolean {
  return draft.title.trim().length > 0;
}

/** Queue the draft as one create, plus the coverage it names on other documents. */
export function createFromDraft(workspace: Workspace, draft: ResourceDraft): string {
  const id = createNode(workspace, {
    nodeKind: 'resource',
    type: draft.type,
    title: draft.title.trim(),
    parentId: draft.parentId,
    member: false,
    patch: {
      capacity: draft.capacity,
      ...(draft.covers.length ? { covers: draft.covers } : {}),
      ...(Object.keys(draft.attributes).length ? { attributes: draft.attributes } : {}),
      ...(draft.body ? { body: draft.body } : {}),
    },
  });
  for (const covererId of draft.coveredBy) {
    const coverer = workspace.node(covererId);
    if (coverer?.kind !== 'resource' || coverer.covers.includes(id)) continue;
    editNode(workspace, covererId, { covers: [...coverer.covers, id] });
  }
  return id;
}
