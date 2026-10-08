import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { LoadedBoard } from '../board/load.js';
import { findIssue, findNode, findOfKind, findPeriod, findResource, isGenericResource, nodesOf, subtreeOf } from '../board/query.js';
import { allowedDepths, hierarchyFor, prefixFor, statusIds } from '../config/lookup.js';
import { requirePlacement } from '../board/registry.js';
import { holdsPlaceholder } from '../../shared/template-params.js';
import { BoardError, ConflictError } from '../errors.js';
import { initialValueFor, isCalendarDate, validateAttributeValue } from '../model/attributes.js';
import type { AnyNode, BaseNode, Issue, NodeKind, Period, Resource, TypeDef } from '../model/types.js';
import { hasPeriods, hasResources } from '../model/types.js';
import { appendActivityEntry } from '../storage/activity.js';
import { sameStamp, stampOf } from '../storage/atomic.js';
import { writeNode } from '../storage/document.js';
import { withBoardWrite } from './git-sync.js';
import { collectionDir, displayPath, documentFileName, nodeDirName } from '../storage/paths.js';
import { allocateIds, counterFor } from '../storage/state.js';

/**
 * Guards and builders shared by create/move/link. Internal to this folder:
 * the public surface is the operations themselves.
 */

/**
 * Run an operation as the board's only writer.
 *
 * Every exported operation wraps its body in this, so a board on a shared
 * checkout serializes its writers instead of interleaving them. It nests, so an
 * operation built out of other operations — `flagIssue` writing a document and
 * then a comment, `claimIssue` delegating to `moveNode` — takes the lock once.
 *
 * `what` is what to tell whoever is waiting; name the document when there is
 * one. @see src/core/storage/lock.ts
 */
export function boardWrite<T>(board: LoadedBoard, what: string, run: () => T): T {
  // When the board is shared through git, the same call commits what `run`
  // wrote and pushes it — or undoes it and refuses. See operations/git-sync.ts.
  return withBoardWrite(board.paths, what, run, board.config);
}

/**
 * Refuse to write over a change this handle never saw.
 *
 * The lock stops two writers overlapping; it cannot help a writer that read the
 * board *before* taking it. That is every operation: a caller loads a board,
 * decides what to do, and only then calls in — and on a shared checkout the
 * document may have been rewritten in between. Comparing the file against the
 * stamp the load recorded is what turns "the last write wins" into "the second
 * writer is told".
 *
 * Called before an operation mutates anything, so a refusal leaves nothing
 * half-done. A document with no stamp is one this handle never read — a
 * document being created — and is not a conflict.
 */
export function requireUnchanged(board: LoadedBoard, node: BaseNode): void {
  const expected = board.stamps.get(node.file);
  if (!expected) return;

  const actual = stampOf(node.file);
  if (actual && sameStamp(expected, actual)) return;

  throw new ConflictError(
    actual
      ? `${node.id} changed on disk while you were working on it`
      : `${node.id} was deleted while you were working on it`,
    [
      `Somebody else — a person, an agent or an editor — wrote ${displayPath(board.paths, node.file)}.`,
      'Nothing was written, so nothing was lost. Read it again and repeat the change.',
    ],
  );
}

/**
 * Write a document and record what was written, so this handle knows it.
 *
 * The stamp update is what lets one operation write the same document twice —
 * a status roll-up and a flag roll-up can meet on the same container — without
 * the second write mistaking its own predecessor for somebody else's edit.
 */
export function writeDocument(board: LoadedBoard, node: AnyNode): void {
  writeNode(node, board.config);
  const stamp = stampOf(node.file);
  if (stamp) board.stamps.set(node.file, stamp);
}

/**
 * Change an issue's flag and record the change in its body, in one call. The
 * only way to move a flag, and the reason is that the two must not come apart.
 *
 * A flag is the one field on a board that says *work has stopped now*, and it
 * is set and cleared as often by the engine as by a person: a container gains
 * one because a story four levels down was flagged, an issue loses one because
 * somebody finished it, `check --fix` repairs a container that drifted. None of
 * those writes a comment — `_comments.md` is where a *person* explains a stall,
 * and one derived entry per ancestor per flag would bury the explanation the
 * flag exists to carry. So the activity section is the record, and it has to be
 * written for every flag change including the ones nobody typed. Otherwise the
 * common case is a red box in `_issue.md`, or a red box that quietly went away,
 * with nothing in the file or in the board's git history saying when or why.
 *
 * Four callers, and there must never be a fifth that skips this:
 * `flagIssue`/`clearFlag` (somebody said so), `moveNode` (finishing the work
 * answered the flag), and both roll-ups in `rollup.ts` (the containers above
 * it). `test/flags.test.ts` greps this package for a bare assignment to
 * `flag` and fails if one appears anywhere but here.
 */
export function setFlag(
  issue: Issue,
  flag: string | null,
  entry: { at: string; author: string; heading: string; text?: string },
): void {
  issue.flag = flag;
  issue.body = appendActivityEntry(issue.body, { ...entry, text: entry.text ?? '' });
}

import { typeDefOf as typeDefByConfig } from '../config/lookup.js';

export function typeDefOf(board: LoadedBoard, kind: NodeKind, type: string): TypeDef {
  return typeDefByConfig(board.config, kind, type);
}

export function requireStatus(board: LoadedBoard, status: string): void {
  const ids = statusIds(board.config);
  if (!ids.includes(status)) {
    throw new BoardError(`Unknown status "${status}"`, [`Available statuses: ${ids.join(', ')}`]);
  }
}

export function requirePeriod(board: LoadedBoard, periodId: string): Period {
  if (!hasPeriods(board.config)) {
    throw new BoardError('This board has no time hierarchy', [
      'Add period_types, period_hierarchy and period_prefix to .lpm/config.yml.',
    ]);
  }
  const period = findPeriod(board, periodId);
  if (!period) throw new BoardError(`No period with id "${periodId}"`);
  return period;
}

export function requireResource(board: LoadedBoard, idOrName: string): Resource {
  if (!hasResources(board.config)) {
    throw new BoardError('This board has no team roster', [
      'Add resource_types, resource_hierarchy and resource_prefix to .lpm/config.yml.',
    ]);
  }
  const resource = findResource(board, idOrName);
  if (!resource) {
    throw new BoardError(`No resource with id or name "${idOrName}"`, [
      board.resources.length
        ? `Roster: ${board.resources.map((entry) => `${entry.id} (${entry.title})`).join(', ')}`
        : 'The roster is empty; add someone with `lpm new <resource type> -t "Name"`.',
    ]);
  }
  return resource;
}

/** A pool anyone can be drawn from, as opposed to a named person. */
export function requireGenericResource(board: LoadedBoard, idOrName: string): Resource {
  const resource = requireResource(board, idOrName);
  if (!isGenericResource(board, resource)) {
    throw new BoardError(`${resource.id} (${resource.title}) is a named resource, not a pool`, [
      'Only generic resources — types declared with `generic: true` — can be covered.',
    ]);
  }
  return resource;
}

export function requireCapacity(capacity: number): void {
  if (!Number.isFinite(capacity) || capacity < 0) {
    throw new BoardError(`Invalid capacity "${capacity}"`, [
      'Capacity is full-time equivalents: 1 for one person, 0.5 part-time, 3 for a pool of three.',
    ]);
  }
}

/** Validate the targets of a `covers` list, normalizing ids and dropping duplicates. */
export function resolveCoverTargets(board: LoadedBoard, ids: string[]): string[] {
  const resolved: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id) continue;
    const pool = requireGenericResource(board, id);
    if (!resolved.includes(pool.id)) resolved.push(pool.id);
  }
  return resolved;
}

export function requireDates(starts: string, ends: string): void {
  if (!isCalendarDate(starts)) {
    throw new BoardError(`Invalid start date "${starts}"`, ['Use YYYY-MM-DD.']);
  }
  if (!isCalendarDate(ends)) {
    throw new BoardError(`Invalid end date "${ends}"`, ['Use YYYY-MM-DD.']);
  }
  if (ends < starts) throw new BoardError(`Period ends (${ends}) before it starts (${starts})`);
}

/**
 * Resolve the parent for a new document and check it sits at a depth its type
 * is allowed at.
 *
 * Depths are a list rather than one number because of the registry's `folder`,
 * which stands in for whichever level nobody templatized and so is legal at all
 * of them. Every declared type appears at exactly one level, so for issues,
 * periods, resources and squads the list has one entry and this reads as it
 * always did. @see allowedDepths
 */
export function resolveParentFor(
  board: LoadedBoard,
  kind: NodeKind,
  type: string,
  parentId: string | undefined,
): BaseNode | null {
  const depths = allowedDepths(board.config, kind, type);
  const levels = hierarchyFor(board.config, kind);
  const parent = parentId
    ? (findOfKind(board, kind, parentId) ?? null)
    : null;

  if (parentId && !parent) throw new BoardError(`No ${kind} with id "${parentId}"`);

  const parentsOf = (depth: number): string[] => levels[depth - 1] ?? [];
  const allowedParents = [...new Set(depths.flatMap(parentsOf))];

  if (parent) {
    if (!depths.includes(parent.depth + 1)) {
      throw new BoardError(`"${type}" cannot be nested under "${parent.type}" (${parent.id})`, [
        allowedParents.length
          ? `"${type}" belongs under: ${allowedParents.join(', ')}`
          : `"${type}" is a top-level type; create it without --parent`,
      ]);
    }
  } else if (!depths.includes(0)) {
    throw new BoardError(`"${type}" needs a parent ${kind}`, [
      `Pass --parent <id>, where the parent is one of: ${allowedParents.join(', ')}`,
    ]);
  }

  // The one rule the hierarchy cannot express: a registry folder groups
  // templates and never sits inside one. @see src/core/board/registry.ts
  if (kind === 'template') requirePlacement(type, parent);

  return parent;
}

/**
 * Seed a document's attributes and validate the ones the caller supplied.
 *
 * `allowPlaceholders` is for the registry: a template's attributes are declared
 * by the issue type it will produce, so a placeholder waiting for a parameter
 * sits in a field of the wrong type until it is filled in. @see holdsPlaceholder
 */
export function buildAttributes(
  typeDef: TypeDef,
  type: string,
  given: Record<string, unknown> | undefined,
  allowPlaceholders = false,
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(typeDef.attributes)) {
    attributes[name] = initialValueFor(def);
  }
  for (const [name, value] of Object.entries(given ?? {})) {
    const def = typeDef.attributes[name];
    if (!def) {
      throw new BoardError(`"${name}" is not an attribute of "${type}"`, [
        `Declared attributes: ${Object.keys(typeDef.attributes).join(', ') || '(none)'}`,
      ]);
    }
    if (!(allowPlaceholders && holdsPlaceholder(value))) {
      const problem = validateAttributeValue(def, value);
      if (problem) throw new BoardError(`Invalid value for "${name}": ${problem}`);
    }
    attributes[name] = value;
  }
  return attributes;
}

export function allocateFor(board: LoadedBoard, kind: NodeKind): string {
  // Guard against every collection: a stale or merge-mangled counter in any
  // namespace must not produce an id that already exists, even though per-kind
  // prefixes normally keep them apart.
  const taken = new Set([
    ...board.issues.map((issue) => issue.id),
    ...board.periods.map((period) => period.id),
    ...board.resources.map((resource) => resource.id),
    ...board.squads.map((squad) => squad.id),
    ...board.templates.map((template) => template.id),
  ]);
  return allocateIds(board.paths, counterFor(kind), prefixFor(board.config, kind), 1, taken)[0]!;
}

export function prepareFolder(board: LoadedBoard, parentDir: string, id: string): string {
  const dir = path.join(parentDir, nodeDirName(id));
  if (existsSync(dir)) {
    throw new BoardError(`Folder already exists: ${displayPath(board.paths, dir)}`);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve the node a document is being moved under, rejecting the two moves
 * that would corrupt the tree: onto itself, and onto one of its descendants.
 */
export function resolveNewParent(
  board: LoadedBoard,
  node: BaseNode,
  parentId: string | null,
): BaseNode | null {
  if (parentId === null) return null;
  const parent = findOfKind(board, node.kind, parentId);
  if (!parent) throw new BoardError(`No ${node.kind} with id "${parentId}"`);
  if (parent.dir === node.dir) throw new BoardError('A document cannot be its own parent');
  if (parent.dir.startsWith(node.dir + path.sep)) {
    throw new BoardError(`Cannot move ${node.id} under its own descendant ${parent.id}`);
  }
  return parent;
}

/**
 * Check that a document and everything below it still sit at a depth their
 * types are allowed at. `overrideType` stands in for the target's own type when
 * the caller is about to change it.
 */
export function requireSubtreeFits(
  board: LoadedBoard,
  target: BaseNode,
  newDepth: number,
  overrideType?: string,
): void {
  const levels = hierarchyFor(board.config, target.kind);
  for (const descendant of subtreeOf(nodesOf(board, target.kind), target)) {
    const depth = newDepth + (descendant.depth - target.depth);
    const type = descendant.dir === target.dir ? (overrideType ?? descendant.type) : descendant.type;
    const allowed = levels[depth] ?? [];
    if (!allowed.includes(type)) {
      throw new BoardError(`This would break the hierarchy at ${descendant.id} ("${type}")`, [
        allowed.length
          ? `Level ${depth} allows: ${allowed.join(', ')}`
          : `The hierarchy has no level ${depth}`,
      ]);
    }
  }
}

/**
 * Move a document's folder under `parent` (or to the collection root), keeping
 * `dir`, `file`, `depth` and `parentId` on the passed node in step. Returns the
 * new board-relative path, or nothing when the folder was already in place.
 */
export function relocateFolder(
  board: LoadedBoard,
  node: AnyNode,
  parent: BaseNode | null,
): string | undefined {
  const parentDir = parent ? parent.dir : collectionDir(board.paths, node.kind);
  const newDir = path.join(parentDir, nodeDirName(node.id));
  node.depth = parent ? parent.depth + 1 : 0;
  node.parentId = parent ? parent.id : null;
  if (newDir === node.dir) return undefined;
  if (existsSync(newDir)) {
    throw new BoardError(`Folder already exists: ${displayPath(board.paths, newDir)}`);
  }
  mkdirSync(path.dirname(newDir), { recursive: true });
  renameSync(node.dir, newDir);
  node.dir = newDir;
  node.file = path.join(newDir, documentFileName(node.kind));
  return displayPath(board.paths, newDir);
}

/**
 * Tidy a `related_files` list: trim, drop blanks, drop duplicates, keep order.
 *
 * Nothing here touches the filesystem or rewrites a path. A reference may name
 * a file that does not exist yet, may carry a line range (`#L10-L42`), and is
 * read by people and agents in whatever checkout they have — so normalizing it
 * to an absolute path would break the one job it has.
 */
export function normalizeFileRefs(refs: string[]): string[] {
  const seen: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (ref && !seen.includes(ref)) seen.push(ref);
  }
  return seen;
}

/** Validate a list of link targets, normalizing ids and dropping duplicates. */
export function resolveLinkTargets(board: LoadedBoard, ids: string[]): string[] {
  const resolved: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id) continue;
    const issue = findIssue(board, id);
    if (!issue) {
      const node = findNode(board, id);
      throw new BoardError(
        node ? `${node.id} is a ${node.type}; only issues can be linked` : `No issue with id "${id}"`,
      );
    }
    if (!resolved.includes(issue.id)) resolved.push(issue.id);
  }
  return resolved;
}

/**
 * The same, inside the registry. A template's dependencies name other templates
 * — they become dependencies between the issues an instantiation produces — so
 * an edge out of the registry into the board is refused rather than copied.
 */
export function resolveTemplateLinkTargets(board: LoadedBoard, ids: string[]): string[] {
  const resolved: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id) continue;
    const template = findOfKind(board, 'template', id);
    if (!template) {
      const node = findNode(board, id);
      throw new BoardError(
        node
          ? `${node.id} is a ${node.kind}; a template can only be linked to another template`
          : `No template with id "${id}"`,
      );
    }
    if (!resolved.includes(template.id)) resolved.push(template.id);
  }
  return resolved;
}
