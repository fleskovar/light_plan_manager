import type { Change, NodePatch } from '../changes.js';
import type { NodeDto, TemplateDto } from '../model.js';
import type { ParamDef } from '../template-params.js';
import { fillValue, placeholdersInValue, resolveParams, substitute } from '../template-params.js';
import type { BoardView, IdFactory } from './reading.js';
import { childrenOf, subtreeIds, typeAtDepth } from './reading.js';
import type { Plan } from './breakdown.js';
import { create, fail, update } from './breakdown.js';

/**
 * Copy a registry template onto the board.
 *
 * The one definition of what instantiating means, so `lpm template apply`, the
 * MCP `instantiate_template` and anything the web grows later cannot disagree
 * about it. Three things it does that are the reason it is worth automating:
 *
 *   - **the answers are filled in everywhere**, not just in the title: bodies,
 *     related files and attribute values all take the parameters, and an
 *     attribute whose whole value is one placeholder keeps the parameter's type;
 *   - **dependencies between the copied templates are kept** and repointed at
 *     the issues just created, so a feature template with three chained stories
 *     lands as three chained stories;
 *   - **the target is checked against the hierarchy** before anything is queued,
 *     because a feature template dropped at the top of a board would produce a
 *     document the engine refuses one change later.
 *
 * A `folder` is not instantiable and neither is a template nested inside
 * another: the root is what somebody chose, and its children come with it.
 */

export interface InstantiateOptions {
  /** Where the copy goes. `null` (or omitted) puts it at the top of the board. */
  parentId?: string | null;
  /** Answers to the template's parameters, by name. */
  params?: Record<string, unknown>;
  /** Schedule the whole copy into this period. */
  period?: string | null;
  /** Assign the whole copy to this resource. */
  assignee?: string | null;
  /** Status for every issue produced. Defaults to the board's. */
  status?: string;
  /**
   * Validate one answer against its declaration. Supplied by the caller because
   * the rule lives in the engine, which this folder may not import.
   */
  validate?: (def: ParamDef, value: unknown) => string | null;
}

const TEMPLATE_ROOT_HINT = 'Only a template root can be instantiated; `lpm template list` shows them.';

/**
 * The registry's container type. Written out rather than imported from core,
 * which this folder may not reach into — the same duplication `FLAG_REASONS`
 * lives with, and for the same reason. @see src/core/model/types.ts
 */
const TEMPLATE_FOLDER = 'folder';

export function planInstantiate(
  view: BoardView,
  nextId: IdFactory,
  templateId: string,
  options: InstantiateOptions = {},
): Plan {
  const root = view.nodes[templateId];
  if (!root) return fail(`No template with id "${templateId}"`);
  if (root.kind !== 'template') {
    return fail(`${templateId} is a ${root.kind}, not a template`, [TEMPLATE_ROOT_HINT]);
  }
  if (!root.root) {
    return fail(
      root.type === TEMPLATE_FOLDER
        ? `${templateId} is a folder, which groups templates rather than being one`
        : `${templateId} is part of a template rather than one of its own`,
      [TEMPLATE_ROOT_HINT],
    );
  }

  const resolved = resolveParams(root.params, options.params ?? {}, options.validate);
  if (resolved.errors.length) {
    return fail(`${templateId} cannot be instantiated with those parameters`, resolved.errors);
  }
  const values = resolved.values;

  // Where the copy lands decides what its root may be, so it is settled before
  // anything is queued. A template of a feature dropped at the top of a board
  // that puts epics there is a mistake worth naming here rather than as a
  // rejected change three steps into the push.
  const parentId = options.parentId ?? null;
  let depth = 0;
  if (parentId !== null) {
    const parent = view.nodes[parentId];
    if (!parent) return fail(`No document with id "${parentId}"`);
    if (parent.kind !== 'issue') {
      return fail(`${parentId} is a ${parent.kind}; a template is instantiated into the board`);
    }
    depth = parent.depth + 1;
  }
  if (typeAtDepth(view.config, 'issue', depth, root.type) !== root.type) {
    const allowed = view.config.hierarchy.issue[depth] ?? [];
    return fail(
      `A "${labelOf(view, root.type)}" cannot sit at level ${depth} of this board`,
      allowed.length
        ? [`Level ${depth} allows: ${allowed.join(', ')}.`, 'Pass a different parent.']
        : [`The hierarchy has no level ${depth}.`],
    );
  }

  // Placeholders naming nothing would be copied onto the board verbatim, which
  // is the one way this quietly produces the wrong document.
  const unknown = unknownPlaceholders(view, root, values);
  if (unknown.length) {
    const declared = Object.keys(root.params);
    return fail(
      `${templateId} refers to ${unknown.length === 1 ? 'a parameter' : 'parameters'} it does not declare`,
      [
        unknown.map((name) => `{{${name}}}`).join(', '),
        declared.length ? `It declares: ${declared.join(', ')}.` : 'It declares none.',
      ],
    );
  }

  // A folder groups templates and is not an issue type, so one nested inside a
  // template would be copied onto the board as a type that does not exist. The
  // operations refuse to create one there and `check` reports it, but a
  // hand-edited or merged registry can still hold one — and the message it
  // deserves is this one, not a rejected change four steps into the push.
  const stray = subtreeIds(view, root.id).filter((id) => {
    const node = view.nodes[id];
    return node?.kind === 'template' && node.type === TEMPLATE_FOLDER;
  });
  if (stray.length) {
    return fail(`${templateId} has a folder nested inside it (${stray.join(', ')})`, [
      'Folders group templates; only templates go inside one.',
      'Run `lpm check` to see it reported against the registry.',
    ]);
  }

  // A title that is nothing but `{{name}}`, answered with nothing, leaves an
  // issue with no title at all — which `createIssue` refuses several steps into
  // the push, naming a document that does not exist yet. Said here instead, in
  // terms of the answer that was missing.
  const blank = subtreeIds(view, root.id).filter((id) => {
    const node = view.nodes[id];
    return node?.kind === 'template' && !substitute(node.title, values).trim();
  });
  if (blank.length) {
    return fail(
      `${templateId} would produce ${blank.length === 1 ? 'a document' : 'documents'} with no title`,
      [
        `Empty after filling in the parameters: ${blank.join(', ')}.`,
        'Give the parameters those titles use a value.',
      ],
    );
  }

  const changes: Change[] = [];
  const created: string[] = [];
  const idMap: Record<string, string> = {};

  const copy = (sourceId: string, into: string | null): void => {
    const node = view.nodes[sourceId];
    if (node?.kind !== 'template') return;
    const issueId = nextId();
    idMap[sourceId] = issueId;
    created.push(issueId);

    const attributes: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(node.attributes)) {
      attributes[name] = fillValue(value, values);
    }

    const patch: NodePatch = {
      type: node.type,
      title: substitute(node.title, values).trim(),
      parentId: into,
      body: substitute(node.body, values),
      attributes,
      relatedFiles: node.relatedFiles.map((ref) => substitute(ref, values)),
      ...(options.status !== undefined ? { status: options.status } : {}),
      // Scheduling is the caller's, not the template's: a reusable piece of plan
      // that pinned a sprint would be wrong the second time it was used.
      ...(options.period !== undefined ? { period: options.period } : {}),
      ...(options.assignee !== undefined ? { assignee: options.assignee } : {}),
    };
    changes.push(create(issueId, 'issue', patch));

    for (const child of childrenOf(view, sourceId)) copy(child.id, issueId);
  };

  copy(root.id, parentId);

  // Edges that ran between the copied templates become edges between the issues
  // they produced. One that left the subtree is dropped, exactly as it is when a
  // structure is duplicated: a fresh copy stands on its own rather than
  // re-blocking whatever the registry entry happened to be filed beside.
  const inside = new Set(subtreeIds(view, root.id));
  for (const [sourceId, issueId] of Object.entries(idMap)) {
    const source = view.nodes[sourceId];
    if (source?.kind !== 'template') continue;
    const dependsOn = source.dependsOn
      .filter((id) => inside.has(id))
      .map((id) => idMap[id])
      .filter((id): id is string => Boolean(id));
    const relatesTo = source.relatesTo
      .filter((id) => inside.has(id))
      .map((id) => idMap[id])
      .filter((id): id is string => Boolean(id));
    if (dependsOn.length || relatesTo.length) {
      changes.push(update(view, issueId, {
        ...(dependsOn.length ? { dependsOn } : {}),
        ...(relatesTo.length ? { relatesTo } : {}),
      }));
    }
  }

  return { ok: true, changes, created };
}

function labelOf(view: BoardView, type: string): string {
  return view.config.types[type]?.label ?? type;
}

/** Parameter names the template's own text uses but its root never declares. */
function unknownPlaceholders(
  view: BoardView,
  root: TemplateDto,
  values: Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  const consider = (value: unknown): void => {
    for (const name of placeholdersInValue(value)) {
      if (name in values || missing.includes(name)) continue;
      missing.push(name);
    }
  };
  for (const id of subtreeIds(view, root.id)) {
    const node: NodeDto | undefined = view.nodes[id];
    if (node?.kind !== 'template') continue;
    consider(node.title);
    consider(node.body);
    consider(node.relatedFiles);
    for (const value of Object.values(node.attributes)) consider(value);
  }
  return missing;
}

/**
 * What a caller has to ask for before it can instantiate: the template, what it
 * says it is for, and every parameter with its declaration.
 *
 * Shaped for a listing rather than for the graph, so `lpm template show`, the
 * MCP tool and a form in the web app all describe a template the same way.
 */
export interface TemplateBrief {
  id: string;
  type: string;
  title: string;
  description: string;
  params: { name: string; def: ParamDef }[];
  /** Ids of everything the instantiation would create, root first. */
  contents: string[];
}

export function briefFor(view: BoardView, templateId: string): TemplateBrief | null {
  const root = view.nodes[templateId];
  if (root?.kind !== 'template') return null;
  return {
    id: root.id,
    type: root.type,
    title: root.title,
    description: root.description,
    params: Object.entries(root.params).map(([name, def]) => ({ name, def })),
    contents: subtreeIds(view, root.id),
  };
}
