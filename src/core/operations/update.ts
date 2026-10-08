import type { LoadedBoard } from '../board/load.js';
import { BoardError } from '../errors.js';
import { validateAttributeValue } from '../model/attributes.js';
import type { AnyNode, ParamDefs } from '../model/types.js';
import { isFolderTemplate } from '../model/types.js';
import { holdsPlaceholder } from '../../shared/template-params.js';
import { nowIso } from '../storage/document.js';
import { mergeActivity } from '../storage/activity.js';
import { writeBoardIndex } from './board-index.js';
import {
  boardWrite,
  normalizeFileRefs,
  requireCapacity,
  requireDates,
  requireUnchanged,
  resolveCoverTargets,
  typeDefOf,
  writeDocument,
} from './shared.js';

/**
 * Edits to a document's own content. Everything that changes where a document
 * *sits* (parent, status, period, assignee) belongs to `moveNode`, and changing
 * its type belongs to `retypeNode`; this is the payload of the document itself.
 *
 * Nothing here touches the filesystem layout: a folder is named after the id
 * alone, so a document keeps its folder however often it is retitled.
 */
export interface UpdateInput {
  title?: string;
  body?: string;
  /** Merged over the current attributes; `undefined` values remove a key. */
  attributes?: Record<string, unknown>;
  /** Issues and templates only: the complete list of files this document is about. */
  relatedFiles?: string[];
  /** Templates only: what this template is for, as the registry shows it. */
  description?: string;
  /** Templates only: the complete set of parameters this template asks for. */
  params?: ParamDefs;
  /** Periods only. */
  starts?: string;
  /** Periods only. */
  ends?: string;
  /**
   * Periods only: the switch over the dates. `true` runs it, `false` parks it,
   * `null` takes the switch off again and hands the period back to its dates.
   */
  active?: boolean | null;
  /** Periods only: squad that owns this period; `null` to clear. */
  squad?: string | null;
  /** Resources only. */
  capacity?: number;
  /** Resources only: generic resources this one can be drawn from. */
  covers?: string[];
  /** Squads only: resource ids that belong to this squad. */
  members?: string[];
}

export interface UpdateResult {
  node: AnyNode;
}

function forKind(node: AnyNode, kind: AnyNode['kind'], field: string): void {
  if (node.kind !== kind) {
    throw new BoardError(`${node.id} is a ${node.kind}; "${field}" applies to ${kind}s only`);
  }
}

export function updateNode(
  board: LoadedBoard,
  target: AnyNode,
  input: UpdateInput,
): UpdateResult {
  return boardWrite(board, `update ${target.id}`, () => updateUnderLock(board, target, input));
}

function updateUnderLock(board: LoadedBoard, target: AnyNode, input: UpdateInput): UpdateResult {
  requireUnchanged(board, target);
  const node: AnyNode = { ...target, attributes: { ...target.attributes } };

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) throw new BoardError(`${node.kind} title cannot be empty`);
    node.title = title;
  }

  // Merge the incoming body with the on-disk body so a stale body edit
  // queued before a flag event and pushed after it cannot clobber the
  // activity section. Incoming prose wins; on-disk activity section wins.
  // Consequence: history is not editable through the tools — corrections
  // are a hand edit to the git-tracked file.
  if (input.body !== undefined) node.body = mergeActivity(input.body, target.body);

  if (input.attributes) {
    const typeDef = node.type ? typeDefOf(board, node.kind, node.type) : null;
    for (const [name, value] of Object.entries(input.attributes)) {
      if (value === undefined) {
        delete node.attributes[name];
        continue;
      }
      const def = typeDef?.attributes[name];
      // Undeclared keys are preserved rather than rejected: `load` keeps the
      // extras people add by hand, and `check` is what reports them.
      // A template's attribute may hold a placeholder instead of a value —
      // `story_points: "{{points}}"` in an integer field — which is what a
      // template *is*. @see holdsPlaceholder
      if (def && !(node.kind === 'template' && holdsPlaceholder(value))) {
        const problem = validateAttributeValue(def, value);
        if (problem) throw new BoardError(`Invalid value for "${name}": ${problem}`);
      }
      node.attributes[name] = value;
    }
  }

  if (input.relatedFiles !== undefined) {
    if (node.kind !== 'issue' && node.kind !== 'template') {
      throw new BoardError(
        `${node.id} is a ${node.kind}; "related files" applies to issues and templates only`,
      );
    }
    node.related_files = normalizeFileRefs(input.relatedFiles);
  }

  if (input.description !== undefined) {
    forKind(node, 'template', 'description');
    if (node.kind === 'template') node.description = input.description.trim();
  }

  if (input.params !== undefined) {
    forKind(node, 'template', 'params');
    if (node.kind === 'template') {
      // Only a root asks for anything; its children take the answers it was
      // given. `createTemplate` refuses the same two placements, and `check`
      // reports a document that already has them. @see isTemplateRoot
      if (Object.keys(input.params).length) {
        if (isFolderTemplate(node)) {
          throw new BoardError('A folder cannot declare parameters', [
            'Parameters belong on the template somebody instantiates, not on the folder holding it.',
          ]);
        }
        const parent = node.parentId ? board.templatesById.get(node.parentId) : undefined;
        if (parent && !isFolderTemplate(parent)) {
          throw new BoardError('Only a root declares parameters', [
            `${node.id} sits inside the template ${parent.id}, so it is part of one.`,
            `Put the parameters on whatever root holds ${node.id}.`,
          ]);
        }
      }
      node.params = input.params;
    }
  }

  if (input.starts !== undefined || input.ends !== undefined) {
    forKind(node, 'period', 'starts/ends');
    const starts = input.starts ?? (node.kind === 'period' ? node.starts : undefined);
    const ends = input.ends ?? (node.kind === 'period' ? node.ends : undefined);
    if (!starts || !ends) throw new BoardError('A period needs both a start and an end date');
    requireDates(starts, ends);
    if (node.kind === 'period') {
      node.starts = starts;
      node.ends = ends;
    }
  }

  if (input.active !== undefined) {
    forKind(node, 'period', 'active');
    // `null` removes the key rather than writing a third value: a period is
    // either switched on, switched off, or back on its dates.
    if (node.kind === 'period') node.active = input.active ?? undefined;
  }

  if (input.squad !== undefined) {
    forKind(node, 'period', 'squad');
    if (input.squad !== null) {
      const squadsById = board.squadsById;
      if (!squadsById.get(input.squad)) {
        throw new BoardError(`No squad with id "${input.squad}"`, [
          board.squads.length
            ? `Available squads: ${board.squads.map((s) => `${s.id} (${s.title})`).join(', ')}`
            : 'This board has no squads.',
        ]);
      }
    }
    if (node.kind === 'period') node.squad = input.squad;
  }

  if (input.capacity !== undefined) {
    forKind(node, 'resource', 'capacity');
    requireCapacity(input.capacity);
    if (node.kind === 'resource') node.capacity = input.capacity;
  }

  if (input.covers !== undefined) {
    forKind(node, 'resource', 'covers');
    const covers = resolveCoverTargets(board, input.covers);
    if (covers.includes(node.id)) throw new BoardError(`${node.id} cannot cover itself`);
    if (node.kind === 'resource') node.covers = covers;
  }

  if (input.members !== undefined) {
    forKind(node, 'squad', 'members');
    const resolved: string[] = [];
    for (const raw of input.members) {
      const id = raw.trim();
      if (!id) continue;
      const resource = board.resourcesById.get(id);
      if (!resource) throw new BoardError(`No resource with id "${id}"`);
      if (!resolved.includes(resource.id)) resolved.push(resource.id);
    }
    if (resolved.includes(node.id)) throw new BoardError(`${node.id} cannot be a member of itself`);
    if (node.kind === 'squad') node.members = resolved;
  }

  node.updated = nowIso();
  writeDocument(board, node);
  // A folder is named after the id, so renaming a document never moves it —
  // but the index carries the title, so it still has to be rewritten.
  writeBoardIndex(board, { node });
  return { node };
}
