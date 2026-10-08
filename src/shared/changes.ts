import type { NodeKind } from './model.js';
import type { ParamDefs } from './template-params.js';

/**
 * The edit protocol.
 *
 * The app never writes to `.lpm` as the user types. Every action appends a
 * `Change` to the open view; pushing replays that list through core operations.
 * Three kinds are enough because every writable field travels as a patch, so
 * one update can rename, retype, reparent and relink a document at once — and
 * two edits to the same document collapse into one (see `compactChanges`).
 */
export interface NodePatch {
  title?: string;
  body?: string;
  /** Changing the type of an existing document; on a create, its type. */
  type?: string;
  /** `null` puts the document at the top level of its collection. */
  parentId?: string | null;
  attributes?: Record<string, unknown>;

  /** Issues only. */
  status?: string;
  assignee?: string | null;
  period?: string | null;
  /** Issues and templates: the complete list of ids this document waits on. */
  dependsOn?: string[];
  relatesTo?: string[];
  /** Issues and templates: the complete list of files this document is about. */
  relatedFiles?: string[];

  /** Templates only: what the registry says this template is for. */
  description?: string;
  /** Templates only: the complete set of parameters it asks for. */
  params?: ParamDefs;
  // There is deliberately no `flag` here. A flag says work has stopped *now*,
  // so it is written straight to disk like a comment; queueing one until
  // somebody pressed Push would hold back the one edit that cannot wait.

  /** Periods only. */
  starts?: string;
  ends?: string;
  /** Periods only: the switch over the dates; `null` hands it back to them. */
  active?: boolean | null;

  /** Periods only: squad that owns this period; `null` to clear. */
  squad?: string | null;

  /** Resources only. */
  capacity?: number;
  covers?: string[];

  /** Squads only: resource ids belonging to this squad. */
  members?: string[];
}

export interface CreateChange {
  kind: 'create';
  /** A temporary id (`new:1`) until the push allocates the real one. */
  id: string;
  nodeKind: NodeKind;
  patch: NodePatch;
}

export interface UpdateChange {
  kind: 'update';
  id: string;
  nodeKind: NodeKind;
  patch: NodePatch;
}

export interface DeleteChange {
  kind: 'delete';
  id: string;
  nodeKind: NodeKind;
}

export type Change = CreateChange | UpdateChange | DeleteChange;

const TEMP_PREFIX = 'new:';

export function tempId(sequence: number): string {
  return `${TEMP_PREFIX}${sequence}`;
}

export function isTempId(id: string): boolean {
  return id.startsWith(TEMP_PREFIX);
}

/** The fields of a patch that name another document, single and list valued. */
const ID_FIELDS = ['parentId', 'assignee', 'period', 'squad'] as const;
const ID_LISTS = ['dependsOn', 'relatesTo', 'covers', 'members'] as const;

/**
 * Rewrite every id a patch points at. The one place that knows which fields
 * carry a reference, so a push and a re-queue can never disagree about them.
 */
export function remapPatch(patch: NodePatch, idMap: Record<string, string>): NodePatch {
  const at = (id: string): string => idMap[id] ?? id;
  const next: NodePatch = { ...patch };
  for (const field of ID_FIELDS) {
    const value = next[field];
    if (typeof value === 'string') next[field] = at(value);
  }
  for (const field of ID_LISTS) {
    const value = next[field];
    if (value) next[field] = value.map(at);
  }
  return next;
}

/** Every id a patch points at, so a caller can ask what it depends on. */
export function patchReferences(patch: NodePatch): string[] {
  const ids: string[] = [];
  for (const field of ID_FIELDS) {
    const value = patch[field];
    if (typeof value === 'string') ids.push(value);
  }
  for (const field of ID_LISTS) ids.push(...(patch[field] ?? []));
  return ids;
}

/**
 * Rewrite the temporary ids in a change list to the ones a push allocated.
 *
 * A push is partial: a change the board rejected stays pending, and it may
 * point at a document that same push created. Left as it arrived, that
 * reference is a `new:` id nothing will ever allocate again — the change can
 * never land, and it reports a document the board has no idea about.
 */
export function remapChanges(changes: Change[], idMap: Record<string, string>): Change[] {
  if (!Object.keys(idMap).length) return changes;
  const at = (id: string): string => idMap[id] ?? id;
  return changes.map((change) =>
    change.kind === 'delete'
      ? { ...change, id: at(change.id) }
      : { ...change, id: at(change.id), patch: remapPatch(change.patch, idMap) },
  );
}

/**
 * Fold a change into a pending list.
 *
 * - an update onto an earlier create or update merges into it, so dragging a
 *   slider pushes one change rather than a hundred;
 * - a delete of something not yet pushed drops its create outright;
 * - a delete drops any pending updates, which have nothing left to apply to.
 *
 * Order is otherwise preserved, because a create must reach the board before
 * anything can reference it.
 */
export function appendChange(pending: Change[], change: Change): Change[] {
  if (change.kind === 'delete') {
    const created = pending.some((entry) => entry.kind === 'create' && entry.id === change.id);
    const rest = pending.filter((entry) => entry.id !== change.id);
    return created ? rest : [...rest, change];
  }

  if (change.kind === 'update') {
    const index = pending.findIndex(
      (entry) => entry.id === change.id && entry.kind !== 'delete',
    );
    if (index >= 0) {
      const existing = pending[index] as CreateChange | UpdateChange;
      const merged = { ...existing, patch: mergePatch(existing.patch, change.patch) };
      return pending.map((entry, at) => (at === index ? merged : entry));
    }
  }

  return [...pending, change];
}

/** Later values win; a key set to `undefined` still counts as "set to nothing". */
export function mergePatch(base: NodePatch, next: NodePatch): NodePatch {
  const merged: NodePatch = { ...base };
  for (const [key, value] of Object.entries(next)) {
    if (key === 'attributes') {
      merged.attributes = { ...base.attributes, ...(value as Record<string, unknown>) };
    } else {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/** Re-fold a whole list, used when a view is loaded from disk. */
export function compactChanges(changes: Change[]): Change[] {
  return changes.reduce<Change[]>(appendChange, []);
}

/** A short human summary of a change, for the pending-changes list. */
export function describeChange(change: Change): string {
  if (change.kind === 'delete') return `Delete ${change.id}`;
  const fields = Object.keys(change.patch).filter((key) => key !== 'type');
  if (change.kind === 'create') {
    return `New ${change.patch.type ?? change.nodeKind} "${change.patch.title ?? 'untitled'}"`;
  }
  return `Edit ${change.id} (${fields.join(', ') || 'no changes'})`;
}
