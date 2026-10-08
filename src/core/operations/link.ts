import type { LoadedBoard } from '../board/load.js';
import { BoardError } from '../errors.js';
import { formatCycle, wouldCycle } from '../model/links.js';
import type { Issue, Resource, Template } from '../model/types.js';
import { nowIso } from '../storage/document.js';
import {
  boardWrite,
  requireUnchanged,
  resolveCoverTargets,
  resolveLinkTargets,
  resolveTemplateLinkTargets,
  writeDocument,
} from './shared.js';

export interface LinkInput {
  dependsOn?: string[];
  relatesTo?: string[];
  /** Remove the given links instead of adding them. */
  remove?: boolean;
}

/**
 * The two document kinds that carry `depends_on`: an issue, and the template it
 * is produced from. A template's edges mean the same thing one level removed —
 * they become the dependencies between the issues an instantiation writes — so
 * they are added, removed and cycle-checked by exactly this code.
 */
export type Linkable = Issue | Template;

export interface LinkResult<T extends Linkable = Issue> {
  issue: T;
  addedDependsOn: string[];
  addedRelatesTo: string[];
  removedDependsOn: string[];
  removedRelatesTo: string[];
}

function linkNode<T extends Linkable>(
  board: LoadedBoard,
  target: T,
  input: LinkInput,
  siblings: Linkable[],
  resolve: (board: LoadedBoard, ids: string[]) => string[],
): LinkResult<T> {
  requireUnchanged(board, target);
  const dependsOn = resolve(board, input.dependsOn ?? []);
  const relatesTo = resolve(board, input.relatesTo ?? []);
  if (!dependsOn.length && !relatesTo.length) {
    throw new BoardError('Nothing to link', ['Pass --depends-on and/or --relates-to.']);
  }

  const issue: T = {
    ...target,
    depends_on: [...target.depends_on],
    relates_to: [...target.relates_to],
  };
  const result: LinkResult<T> = {
    issue,
    addedDependsOn: [],
    addedRelatesTo: [],
    removedDependsOn: [],
    removedRelatesTo: [],
  };

  /**
   * Add or drop a `relates_to` edge. It implies nothing and can point anywhere,
   * so self-reference is the only thing to refuse; `depends_on` is handled on
   * its own below, because it orders work and so has to refuse a cycle.
   */
  const edit = (
    stored: string[],
    wanted: string[],
    added: string[],
    removed: string[],
    verb: string,
  ): void => {
    for (const id of wanted) {
      const index = stored.indexOf(id);
      if (input.remove) {
        if (index >= 0) {
          stored.splice(index, 1);
          removed.push(id);
        }
        continue;
      }
      if (id === issue.id) throw new BoardError(`${issue.id} cannot ${verb} itself`);
      if (index >= 0) continue;
      stored.push(id);
      added.push(id);
    }
  };

  /** Add or drop a dependency, refusing one that closes a loop. */
  const gate = (wanted: string[], added: string[], removed: string[]): void => {
    const stored = issue.depends_on;
    for (const id of wanted) {
      if (input.remove) {
        const index = stored.indexOf(id);
        if (index >= 0) {
          stored.splice(index, 1);
          removed.push(id);
        }
        continue;
      }
      if (id === issue.id) throw new BoardError(`${issue.id} cannot depend on itself`);
      if (stored.includes(id)) continue;
      // Check against the collection plus the edges added so far in this call.
      const projected = siblings.map((other) =>
        other.id === issue.id ? { ...other, depends_on: [...stored, id] } : other,
      );
      const cycle = wouldCycle(projected, issue.id, id);
      if (cycle) {
        throw new BoardError('Adding this depend on link would create a cycle', [
          formatCycle(cycle),
          'A dependency decides what the queue offers, so a loop through one would stall the work for good.',
        ]);
      }
      stored.push(id);
      added.push(id);
    }
  };

  gate(dependsOn, result.addedDependsOn, result.removedDependsOn);
  edit(issue.relates_to, relatesTo, result.addedRelatesTo, result.removedRelatesTo, 'relate to');

  const changed =
    result.addedDependsOn.length ||
    result.addedRelatesTo.length ||
    result.removedDependsOn.length ||
    result.removedRelatesTo.length;
  if (changed) {
    issue.updated = nowIso();
    writeDocument(board, issue);
  }
  return result;
}

export function linkIssue(board: LoadedBoard, target: Issue, input: LinkInput): LinkResult<Issue> {
  return boardWrite(board, `link ${target.id}`, () =>
    linkNode(board, target, input, board.issues, resolveLinkTargets),
  );
}

/** The same edge, between two registry templates. */
export function linkTemplate(
  board: LoadedBoard,
  target: Template,
  input: LinkInput,
): LinkResult<Template> {
  return boardWrite(board, `link ${target.id}`, () =>
    linkNode(board, target, input, board.templates, resolveTemplateLinkTargets),
  );
}

export interface CoverInput {
  /** Generic resources the target can be drawn from. */
  covers: string[];
  remove?: boolean;
}

export interface CoverResult {
  resource: Resource;
  added: string[];
  removed: string[];
}

/**
 * Record that a resource can pick up work parked in a pool. Like `depends_on`,
 * only the forward edge is stored; `board.coveredBy` is derived at load time.
 */
export function linkResource(
  board: LoadedBoard,
  target: Resource,
  input: CoverInput,
): CoverResult {
  return boardWrite(board, `link ${target.id}`, () => coverUnderLock(board, target, input));
}

function coverUnderLock(board: LoadedBoard, target: Resource, input: CoverInput): CoverResult {
  requireUnchanged(board, target);
  const covers = resolveCoverTargets(board, input.covers);
  if (!covers.length) throw new BoardError('Nothing to link', ['Pass --covers <id>.']);

  const resource: Resource = { ...target, covers: [...target.covers] };
  const result: CoverResult = { resource, added: [], removed: [] };

  for (const id of covers) {
    if (input.remove) {
      const index = resource.covers.indexOf(id);
      if (index >= 0) {
        resource.covers.splice(index, 1);
        result.removed.push(id);
      }
      continue;
    }
    if (id === resource.id) throw new BoardError(`${resource.id} cannot cover itself`);
    if (resource.covers.includes(id)) continue;
    resource.covers.push(id);
    result.added.push(id);
  }

  if (result.added.length || result.removed.length) {
    resource.updated = nowIso();
    writeDocument(board, resource);
  }
  return result;
}
