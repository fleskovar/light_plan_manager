import type { LoadedBoard } from '../../board/load.js';
import { isTemplateRoot, placementProblem } from '../../board/registry.js';
import { validateAttributeValue } from '../../model/attributes.js';
import type { Problem } from '../../model/types.js';
import { isFolderTemplate } from '../../model/types.js';
import { placeholdersInValue } from '../../../shared/template-params.js';
import { at } from '../shared.js';

/**
 * What is true of a registry template beyond what is true of any document.
 *
 * `checkCollection` already covers ids, types, depths and attributes, because
 * the registry is a collection like the others. This is the part that is the
 * registry's own: what a folder may hold, who may declare parameters, and
 * whether the placeholders a template writes name parameters it asks for.
 *
 * A template can never make the *board* wrong — nothing in `board/` reads one —
 * so these are reported for a person to fix rather than blocking anything.
 */
export function checkTemplates(board: LoadedBoard, problems: Problem[]): void {
  const declared = new Set(board.templates.map((template) => template.id));

  for (const template of board.templates) {
    const where = at(board, template);
    const parent = template.parentId
      ? (board.templatesById.get(template.parentId) ?? null)
      : null;

    const placement = placementProblem(template.type, parent);
    if (placement) problems.push({ level: 'error', path: where, message: placement });

    const root = isTemplateRoot(board, template);

    if (Object.keys(template.params).length) {
      if (isFolderTemplate(template)) {
        problems.push({
          level: 'error',
          path: where,
          message: 'a folder cannot declare parameters',
        });
      } else if (!root) {
        problems.push({
          level: 'error',
          path: where,
          message:
            'only the root of a template may declare parameters; this one is nested inside ' +
            `${template.parentId}, which is what gets instantiated`,
        });
      }
    }

    for (const [name, def] of Object.entries(template.params)) {
      if (def.default === undefined) continue;
      const problem = validateAttributeValue(def, def.default);
      if (problem) {
        problems.push({
          level: 'error',
          path: where,
          message: `params.${name}.default: ${problem}`,
        });
      }
    }

    if (root && !template.description) {
      problems.push({
        level: 'warn',
        path: where,
        message: 'no description; the registry listing will have nothing to say about it',
      });
    }

    for (const field of ['depends_on', 'relates_to'] as const) {
      for (const id of template[field]) {
        if (id === template.id) {
          problems.push({
            level: 'error',
            path: where,
            message: `${field} lists itself`,
            fixable: true,
          });
        } else if (!declared.has(id)) {
          problems.push({
            level: 'error',
            path: where,
            message: `${field} names "${id}", which is not in the registry`,
          });
        }
      }
    }

    // A placeholder naming nothing is written into the board verbatim, which is
    // the one way a template quietly produces the wrong document. It is checked
    // against the *root's* parameters, because the whole subtree is filled from
    // the answers given to the root.
    const rootOf = rootFor(board, template);
    const available = new Set(Object.keys(rootOf?.params ?? {}));
    const referenced = [
      ...placeholdersInValue(template.title),
      ...placeholdersInValue(template.body),
      ...placeholdersInValue(template.related_files),
      ...Object.values(template.attributes).flatMap(placeholdersInValue),
    ];
    for (const name of new Set(referenced)) {
      if (available.has(name)) continue;
      problems.push({
        level: 'warn',
        path: where,
        message:
          `{{${name}}} is not a parameter of ${rootOf ? rootOf.id : 'this template'}` +
          (available.size ? ` (it declares: ${[...available].join(', ')})` : ' (it declares none)'),
      });
    }
  }
}

/** The template that would be instantiated to produce this one. */
function rootFor(board: LoadedBoard, template: { id: string; parentId: string | null }) {
  const seen = new Set<string>();
  let current = board.templatesById.get(template.id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (isTemplateRoot(board, current)) return current;
    current = current.parentId ? board.templatesById.get(current.parentId) : undefined;
  }
  return null;
}
