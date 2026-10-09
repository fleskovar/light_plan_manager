import type { AnyNode, Issue, LinkInput, Template } from '../core/index.js';
import {
  BoardError,
  createIssue,
  createPeriod,
  createResource,
  createSquad,
  createTemplate,
  linkIssue,
  linkTemplate,
  moveNode,
  retypeNode,
  updateNode,
} from '../core/index.js';
import type { NodeKind, NodePatch } from '../shared/index.js';
import type { PushSession } from './session.js';

/**
 * One patch, expanded into the core operations that carry it out.
 *
 * The order below is the whole trick: a patch may say "this feature is now a
 * story under that other feature, called something else, blocked by these two".
 * Retyping and reparenting move the folder, so they go first; renaming moves it
 * again, so it goes after; links go last, once every id in the patch exists.
 */

function createInput(patch: NodePatch): { type: string; title: string } {
  if (!patch.type) throw new BoardError('A new document needs a type');
  return { type: patch.type, title: patch.title ?? 'Untitled' };
}

export interface CreatedNode {
  node: AnyNode;
  /**
   * Links this document wants but could not have yet, because they point at
   * something later in the same push. The caller replays these at the end.
   */
  deferred?: NodePatch;
}

/** True for a reference to something this push has not created yet. */
function unresolved(session: PushSession, id: string | null | undefined): boolean {
  return typeof id === 'string' && session.unresolved(id);
}

/**
 * Split a link list into what can be written now and what has to wait.
 *
 * A plan may create two documents and point the first at the second - copying a
 * structure does exactly that. Core resolves link targets when it writes, so the
 * forward reference is held back and applied once everything exists.
 */
function splitLinks(
  session: PushSession,
  wanted: string[] | undefined,
): { now?: string[]; later?: string[] } {
  if (!wanted?.length) return {};
  const now = wanted.filter((id) => !unresolved(session, id));
  return now.length === wanted.length ? { now } : { now, later: wanted };
}

export function createNode(
  session: PushSession,
  nodeKind: NodeKind,
  raw: NodePatch,
): CreatedNode {
  const patch = session.resolvePatch(raw);
  const { type, title } = createInput(patch);
  const parentId = patch.parentId ?? undefined;

  const dependsOn = splitLinks(session, patch.dependsOn);
  const relatesTo = splitLinks(session, patch.relatesTo);
  const covers = splitLinks(session, patch.covers);
  const members = splitLinks(session, patch.members);
  // Scheduling waits for the same reason a link does: a sprint or a teammate
  // created later in the push is a document `move` cannot be told about yet.
  const laterPeriod = unresolved(session, patch.period);
  const laterAssignee = unresolved(session, patch.assignee);
  const deferred: NodePatch = {
    ...(dependsOn.later ? { dependsOn: dependsOn.later } : {}),
    ...(relatesTo.later ? { relatesTo: relatesTo.later } : {}),
    ...(covers.later ? { covers: covers.later } : {}),
    ...(members.later ? { members: members.later } : {}),
    ...(laterPeriod ? { period: patch.period } : {}),
    ...(laterAssignee ? { assignee: patch.assignee } : {}),
  };

  let node: AnyNode;
  if (nodeKind === 'issue') {
    node = createIssue(session.board, {
      type,
      title,
      parentId,
      status: patch.status,
      // `null` is a decision (unscheduled, even on a board with a catch-all
      // period); absent leaves the choice to `createIssue`.
      period: laterPeriod ? undefined : patch.period,
      assignee: (laterAssignee ? undefined : patch.assignee) ?? undefined,
      dependsOn: dependsOn.now,
      relatesTo: relatesTo.now,
      relatedFiles: patch.relatedFiles,
      attributes: patch.attributes,
    });
  } else if (nodeKind === 'period') {
    if (!patch.starts || !patch.ends) {
      throw new BoardError('A new period needs a start and an end date');
    }
    node = createPeriod(session.board, {
      type,
      title,
      parentId,
      starts: patch.starts,
      ends: patch.ends,
      active: patch.active ?? undefined,
      squad: patch.squad ?? undefined,
      attributes: patch.attributes,
    });
  } else if (nodeKind === 'resource') {
    node = createResource(session.board, {
      type,
      title,
      parentId,
      capacity: patch.capacity,
      covers: covers.now,
      attributes: patch.attributes,
    });
  } else if (nodeKind === 'template') {
    node = createTemplate(session.board, {
      type,
      title,
      parentId,
      description: patch.description,
      params: patch.params,
      dependsOn: dependsOn.now,
      relatesTo: relatesTo.now,
      relatedFiles: patch.relatedFiles,
      attributes: patch.attributes,
    });
  } else {
    node = createSquad(session.board, {
      type,
      title,
      members: members.now,
      attributes: patch.attributes,
    });
  }

  // The type's body template is written by create; an explicit body replaces it.
  if (patch.body !== undefined) {
    session.reload();
    updateNode(session.board, session.require(nodeKind, node.id), { body: patch.body });
  }
  return Object.keys(deferred).length ? { node, deferred } : { node };
}

function relocate(session: PushSession, nodeKind: NodeKind, id: string, patch: NodePatch): void {
  const node = session.require(nodeKind, id);
  const retyping = patch.type !== undefined && patch.type !== node.type;

  if (retyping) {
    retypeNode(session.board, node, {
      type: patch.type!,
      ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
    });
    session.reload();
  } else if (patch.parentId !== undefined) {
    moveNode(session.board, node, { parentId: patch.parentId });
    session.reload();
  }
}

function reschedule(session: PushSession, nodeKind: NodeKind, id: string, patch: NodePatch): void {
  const fields = {
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.assignee !== undefined ? { assignee: patch.assignee } : {}),
    ...(patch.period !== undefined ? { period: patch.period } : {}),
  };
  if (!Object.keys(fields).length) return;
  moveNode(session.board, session.require(nodeKind, id), fields);
  session.reload();
}

function edit(session: PushSession, nodeKind: NodeKind, id: string, patch: NodePatch): void {
  const fields = {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.body !== undefined ? { body: patch.body } : {}),
    ...(patch.attributes !== undefined ? { attributes: patch.attributes } : {}),
    ...(patch.relatedFiles !== undefined ? { relatedFiles: patch.relatedFiles } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.params !== undefined ? { params: patch.params } : {}),
    ...(patch.starts !== undefined ? { starts: patch.starts } : {}),
    ...(patch.ends !== undefined ? { ends: patch.ends } : {}),
    ...(patch.active !== undefined ? { active: patch.active } : {}),
    ...(patch.squad !== undefined ? { squad: patch.squad } : {}),
    ...(patch.capacity !== undefined ? { capacity: patch.capacity } : {}),
    ...(patch.covers !== undefined ? { covers: patch.covers } : {}),
    ...(patch.members !== undefined ? { members: patch.members } : {}),
  };
  if (!Object.keys(fields).length) return;
  updateNode(session.board, session.require(nodeKind, id), fields);
  session.reload();
}

/**
 * Links arrive as the complete list the client wants, but core adds and removes
 * one edge at a time — deliberately, because that is where the cycle check
 * lives. So the difference is what gets applied.
 */
function relink(
  session: PushSession,
  nodeKind: 'issue' | 'template',
  id: string,
  patch: NodePatch,
): void {
  if (
    patch.dependsOn === undefined &&
    patch.relatesTo === undefined
  ) {
    return;
  }
  // A template's edges are the same edge one level removed — they become the
  // dependencies between the issues an instantiation writes — so they are
  // added, removed and cycle-checked by the same code.
  const read = (): Issue | Template => session.require(nodeKind, id) as Issue | Template;
  const apply = (target: Issue | Template, input: LinkInput): void => {
    if (target.kind === 'issue') linkIssue(session.board, target, input);
    else linkTemplate(session.board, target, input);
  };
  const issue = read();

  const missing = (wanted: string[] | undefined, current: string[]): string[] =>
    (wanted ?? current).filter((entry) => !current.includes(entry));
  const extra = (wanted: string[] | undefined, current: string[]): string[] =>
    wanted === undefined ? [] : current.filter((entry) => !wanted.includes(entry));

  const removeDepends = extra(patch.dependsOn, issue.depends_on);
  const removeRelates = extra(patch.relatesTo, issue.relates_to);
  if (removeDepends.length || removeRelates.length) {
    apply(issue, { dependsOn: removeDepends, relatesTo: removeRelates, remove: true });
    session.reload();
  }

  const current = read();
  const addDepends = missing(patch.dependsOn, current.depends_on);
  const addRelates = missing(patch.relatesTo, current.relates_to);
  if (addDepends.length || addRelates.length) {
    apply(current, { dependsOn: addDepends, relatesTo: addRelates });
    session.reload();
  }
}

export function applyPatch(
  session: PushSession,
  nodeKind: NodeKind,
  id: string,
  raw: NodePatch,
): void {
  const patch = session.resolvePatch(raw);
  relocate(session, nodeKind, id, patch);
  reschedule(session, nodeKind, id, patch);
  edit(session, nodeKind, id, patch);
  if (nodeKind === 'issue' || nodeKind === 'template') relink(session, nodeKind, id, patch);
}
