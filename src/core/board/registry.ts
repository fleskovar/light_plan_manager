import { BoardError } from '../errors.js';
import type { Template } from '../model/types.js';
import { TEMPLATE_FOLDER_TYPE, isFolderTemplate } from '../model/types.js';
import { subtreeOf } from './query.js';
import type { LoadedBoard } from './load.js';

/**
 * Reading the template registry.
 *
 * The registry is a collection like any other, so loading, checking, moving and
 * deleting come for free. What it adds is one distinction the other collections
 * do not have: some of its documents are *containers* and the rest are the
 * things somebody instantiates. Everything that depends on that distinction is
 * here, so no front end has to re-derive it.
 */

/**
 * A template somebody can instantiate: one whose parent is a folder, or nothing.
 *
 * Anything else is *inside* a template — the three stories under a feature
 * template are part of the feature, not three separate offers — and a folder is
 * scaffolding. So this is exactly the list the registry shows and exactly the
 * set of ids `instantiate` accepts.
 */
export function isTemplateRoot(board: LoadedBoard, template: Template): boolean {
  if (isFolderTemplate(template)) return false;
  if (!template.parentId) return true;
  const parent = board.templatesById.get(template.parentId);
  return parent ? isFolderTemplate(parent) : true;
}

/** Every template that can be instantiated, in registry order. */
export function templateRoots(board: LoadedBoard): Template[] {
  return board.templates.filter((template) => isTemplateRoot(board, template));
}

/** Resolve a template by id, case-insensitively, so `tpl-3` finds `TPL-3`. */
export function findTemplate(board: LoadedBoard, id: string): Template | null {
  const exact = board.templatesById.get(id);
  if (exact) return exact;
  const wanted = id.toLowerCase();
  return board.templates.find((template) => template.id.toLowerCase() === wanted) ?? null;
}

/** A template and everything nested under it, parents first. */
export function templateSubtree(board: LoadedBoard, root: Template): Template[] {
  return subtreeOf(board.templates, root);
}

/**
 * The folder path a template sits under, outermost first — "Delivery / Backend".
 * What makes a listing of forty templates readable.
 */
export function templatePath(board: LoadedBoard, template: Template): string[] {
  const names: string[] = [];
  const seen = new Set<string>([template.id]);
  let current = template.parentId ? board.templatesById.get(template.parentId) : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.title);
    current = current.parentId ? board.templatesById.get(current.parentId) : undefined;
  }
  return names;
}

/**
 * Why this template may not sit under that parent, or null when it may.
 *
 * The depth rules are the hierarchy's and are checked everywhere else; this is
 * the one rule the registry adds. A folder stands in for a level nobody
 * templatized, so it belongs beside templates and never inside one — a folder
 * halfway down a feature template would be a level of the produced issue tree
 * with nothing to put in it.
 */
export function placementProblem(
  type: string,
  parent: { type: string; id: string } | null,
): string | null {
  if (type !== TEMPLATE_FOLDER_TYPE) return null;
  if (parent && parent.type !== TEMPLATE_FOLDER_TYPE) {
    return `A folder cannot sit inside the template ${parent.id}`;
  }
  return null;
}

/** Throw when a placement breaks the rule above. */
export function requirePlacement(
  type: string,
  parent: { type: string; id: string } | null,
): void {
  const problem = placementProblem(type, parent);
  if (problem) {
    throw new BoardError(problem, [
      'Folders group templates; only templates and other folders go inside one.',
    ]);
  }
}

/** Resolve a template that must exist, with a message naming the registry. */
export function requireTemplate(board: LoadedBoard, id: string): Template {
  const template = findTemplate(board, id);
  if (!template) {
    throw new BoardError(`No template with id "${id}"`, [
      board.templates.length
        ? 'Run `lpm template list` to see the registry.'
        : 'The registry is empty; add one with `lpm template new <type> -t "..."`.',
    ]);
  }
  return template;
}
