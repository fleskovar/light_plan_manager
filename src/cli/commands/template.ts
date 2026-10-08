import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { LoadedBoard, ParamDef, Template } from '../../core/index.js';
import {
  BoardError,
  TEMPLATE_FOLDER_TYPE,
  createTemplate,
  findNode,
  isTemplateRoot,
  parseAttributeInput,
  requireTemplate,
  templatePath,
  templateSubtree,
  typeDefOf,
  validateAttributeValue,
} from '../../core/index.js';
import { counterFactory, planInstantiate } from '../../shared/index.js';
import { requireBoard } from '../context.js';
import { boardView, printCreated, runPlan } from '../plan.js';
import { bold, cyan, dim, green, out, pad, plural, yellow } from '../ui.js';

export const help = `The template registry: reusable pieces of plan, and putting them on the board.

Usage
  lpm template list [--all]
  lpm template show <TPL-id>
  lpm template new <type|folder> -t "Title" [options]
  lpm template apply <TPL-id> [options]

Subcommands
  list        What the registry offers, with what each one is for
  show        One template: its parameters, and everything it would create
  new         Add a template or a folder to the registry
  apply       Copy a template onto the board, filling in its parameters

Options for \`new\`
  -t, --title <text>        Title. May contain {{parameters}}
  -d, --description <text>  What this template is for; shown in the listing
      --parent <TPL-id>     Nest it under this folder or template
      --param <spec>        Declare a parameter: name:type[:required][=default],
                            and values(a|b) for an enum
      --set key=value       An attribute value (repeatable)

Options for \`apply\`
      --under <id>        Issue to create it under; omit for the top level
      --params <file>     A JSON object of parameter values
      --set key=value     One parameter value, overriding the file (repeatable)
      --period <id>       Schedule everything it creates into this period
      --assignee <who>    Assign everything it creates
      --dry-run           Say what would happen, change nothing

A template is written in the board's own issue types and nests the same way, so
a template of a feature holds templates of stories. A \`folder\` stands in for a
level nobody templatized: to keep a feature template on its own, put it under a
folder where the epic would be.

Parameters are declared on the template somebody instantiates — its root — and
are filled in throughout it: titles, bodies, related files and attribute values
all take {{name}}.

Examples
  lpm template list
  lpm template new folder -t "Delivery"              # TPL-1, at the top level
  lpm template new folder -t "Epic slot" --parent TPL-1   # TPL-2, an epic's place
  lpm template new feature -t "{{name}} API" --parent TPL-2 \\
      -d "REST endpoint with tests and docs" --param name:string:required
  lpm template new user_story -t "Build {{name}}" --parent TPL-3
  lpm template apply TPL-3 --params ./payments.json --under LP-4
  lpm template apply TPL-3 --set name=Payments --dry-run`;

export function run(args: string[]): number {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case undefined:
    case 'list':
      return list(rest);
    case 'show':
      return show(rest);
    case 'new':
      return create(rest);
    case 'apply':
      return apply(rest);
    default:
      throw new BoardError(`Unknown subcommand "${subcommand}"`, [
        'Use list, show, new or apply.',
      ]);
  }
}

// -- list ------------------------------------------------------------------

function list(args: string[]): number {
  const { values } = parseArgs({ args, options: { all: { type: 'boolean' } } });
  const board = requireBoard();

  if (!board.templates.length) {
    out(dim('The registry is empty.'));
    out(dim('Add one with `lpm template new <type> -t "..." -d "what it is for"`.'));
    return 0;
  }

  const shown = values.all
    ? board.templates
    : board.templates.filter((template) => isTemplateRoot(board, template));

  if (!shown.length) {
    out(dim('The registry holds only folders. Add a template inside one.'));
    return 0;
  }

  for (const template of shown) {
    const where = templatePath(board, template);
    const label = typeLabel(board, template);
    const pieces = templateSubtree(board, template).length - 1;
    out(
      `${bold(pad(template.id, 8))} ${cyan(pad(label, 12))} ${template.title}` +
        (pieces > 0 ? dim(`  (+${plural(pieces, 'document')})`) : ''),
    );
    if (where.length) out(`  ${dim(where.join(' / '))}`);
    if (template.description) out(`  ${template.description}`);
    const params = Object.keys(template.params);
    if (params.length) out(`  ${dim(`parameters: ${params.join(', ')}`)}`);
  }
  return 0;
}

function typeLabel(board: LoadedBoard, template: Template): string {
  if (template.type === TEMPLATE_FOLDER_TYPE) return 'folder';
  return board.config.issue_types[template.type]?.label ?? template.type;
}

// -- show ------------------------------------------------------------------

function show(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const id = positionals[0];
  if (!id) throw new BoardError('Missing id', ['Usage: lpm template show <TPL-id>']);

  const board = requireBoard();
  const template = requireTemplate(board, id);

  out(`${bold(template.id)}  ${template.title}  ${dim(typeLabel(board, template))}`);
  if (template.description) out(template.description);
  const path = templatePath(board, template);
  if (path.length) out(dim(`in ${path.join(' / ')}`));
  out();

  const params = Object.entries(template.params);
  if (params.length) {
    out(bold('Parameters'));
    for (const [name, def] of params) {
      const notes = [
        def.type,
        def.required ? 'required' : null,
        def.default !== undefined ? `default ${JSON.stringify(def.default)}` : null,
        def.values ? `one of ${def.values.join(', ')}` : null,
      ].filter(Boolean);
      out(`  ${pad(name, 16)}${dim(notes.join(', '))}`);
      if (def.description) out(`  ${' '.repeat(16)}${def.description}`);
    }
    out();
  } else if (isTemplateRoot(board, template)) {
    out(dim('This template takes no parameters.'));
    out();
  }

  const subtree = templateSubtree(board, template);
  out(bold(subtree.length === 1 ? 'Creates' : 'Creates, in this shape'));
  for (const node of subtree) {
    const indent = '  '.repeat(node.depth - template.depth + 1);
    out(`${indent}${cyan(typeLabel(board, node))}  ${node.title}`);
    if (node.depends_on.length) out(`${indent}  ${dim(`after ${node.depends_on.join(', ')}`)}`);
  }

  if (!isTemplateRoot(board, template)) {
    out();
    out(
      dim(
        template.type === TEMPLATE_FOLDER_TYPE
          ? 'This is a folder; instantiate one of the templates inside it.'
          : 'This is part of a larger template; instantiate the root instead.',
      ),
    );
  }
  return 0;
}

// -- new -------------------------------------------------------------------

/** `name:type`, `name:type:required`, `name:type=default`, all four combined. */
function parseParamSpec(spec: string): { name: string; def: ParamDef } {
  const [declaration, ...defaultParts] = spec.split('=');
  const rawDefault = defaultParts.length ? defaultParts.join('=') : undefined;
  const [name, type, ...flags] = declaration!.split(':');
  if (!name || !type) {
    throw new BoardError(`Invalid --param "${spec}"`, [
      'Expected name:type, optionally :required and =default.',
      'Types: string, text, int, float, bool, date, enum, array.',
    ]);
  }
  const def: ParamDef = { type: type as ParamDef['type'] };
  for (const flag of flags) {
    if (flag === 'required') def.required = true;
    else if (flag.startsWith('values(') && flag.endsWith(')')) {
      def.values = flag.slice('values('.length, -1).split('|');
    } else throw new BoardError(`Unknown flag ":${flag}" in --param "${spec}"`);
  }
  if (rawDefault !== undefined) {
    const parsed = parseAttributeInput(def, rawDefault);
    if (parsed.error) throw new BoardError(`--param ${name}: ${parsed.error}`);
    def.default = parsed.value;
  }
  return { name, def };
}

function create(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      title: { type: 'string', short: 't' },
      description: { type: 'string', short: 'd' },
      parent: { type: 'string' },
      param: { type: 'string', multiple: true },
      set: { type: 'string', multiple: true },
    },
  });

  const type = positionals[0];
  if (!type) {
    throw new BoardError('Missing type', [
      'Usage: lpm template new <type|folder> -t "Title"',
    ]);
  }
  if (!values.title) throw new BoardError('Missing --title');

  const board = requireBoard();
  const typeDef = typeDefOf(board.config, 'template', type);

  const params: Record<string, ParamDef> = {};
  for (const spec of values.param ?? []) {
    const { name, def } = parseParamSpec(spec);
    params[name] = def;
  }

  const attributes: Record<string, unknown> = {};
  for (const entry of values.set ?? []) {
    const split = entry.indexOf('=');
    if (split < 1) throw new BoardError(`Invalid --set "${entry}"`, ['Expected key=value.']);
    const key = entry.slice(0, split).trim();
    const def = typeDef.attributes[key];
    if (!def) {
      throw new BoardError(`"${key}" is not an attribute of "${type}"`, [
        `Declared attributes: ${Object.keys(typeDef.attributes).join(', ') || '(none)'}`,
      ]);
    }
    // An attribute holding a placeholder is filled in at instantiation, so it
    // is stored as written rather than parsed against the attribute's type.
    const raw = entry.slice(split + 1);
    if (/\{\{\s*[A-Za-z]/.test(raw)) {
      attributes[key] = raw;
      continue;
    }
    const parsed = parseAttributeInput(def, raw);
    if (parsed.error) throw new BoardError(`--set ${key}: ${parsed.error}`);
    attributes[key] = parsed.value;
  }

  const template = createTemplate(board, {
    type,
    title: values.title,
    description: values.description,
    parentId: values.parent,
    params,
    attributes,
  });

  out(`${green('Created')} ${bold(template.id)}  ${template.title}`);
  out(dim(`  ${template.file.replace(board.paths.root, '').replace(/^[\\/]/, '')}`));
  return 0;
}

// -- apply -----------------------------------------------------------------

function readParamsFile(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new BoardError(`Cannot read ${file}`, [(error as Error).message]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BoardError(`${file} is not valid JSON`, [(error as Error).message]);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BoardError(`${file} must hold a JSON object of parameter values`);
  }
  return parsed as Record<string, unknown>;
}

function apply(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      under: { type: 'string' },
      params: { type: 'string' },
      set: { type: 'string', multiple: true },
      period: { type: 'string' },
      assignee: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  });

  const id = positionals[0];
  if (!id) throw new BoardError('Missing id', ['Usage: lpm template apply <TPL-id>']);

  const board = requireBoard();
  const template = requireTemplate(board, id);

  const given: Record<string, unknown> = values.params ? readParamsFile(values.params) : {};
  for (const entry of values.set ?? []) {
    const split = entry.indexOf('=');
    if (split < 1) throw new BoardError(`Invalid --set "${entry}"`, ['Expected key=value.']);
    const name = entry.slice(0, split).trim();
    const def = template.params[name];
    // An answer the template never asked for is refused by the planner, with a
    // message listing what it does ask for; parsing it here would say less.
    if (!def) {
      given[name] = entry.slice(split + 1);
      continue;
    }
    const parsed = parseAttributeInput(def, entry.slice(split + 1));
    if (parsed.error) throw new BoardError(`--set ${name}: ${parsed.error}`);
    given[name] = parsed.value;
  }

  if (values.under && !findNode(board, values.under)) {
    throw new BoardError(`No document with id "${values.under}"`);
  }

  const plan = planInstantiate(boardView(board), counterFactory(), template.id, {
    parentId: values.under ?? null,
    params: given,
    period: values.period,
    assignee: values.assignee,
    validate: validateAttributeValue,
  });
  if (!plan.ok) throw new BoardError(plan.error, plan.details);

  if (values['dry-run']) {
    out(`${yellow('Would create')} ${plural(plan.created.length, 'document')} from ${bold(template.id)}`);
    for (const change of plan.changes) {
      if (change.kind === 'create') out(`  + ${change.patch.type}  ${change.patch.title}`);
    }
    return 0;
  }

  const { created } = runPlan(board, plan, 'Instantiate');
  out(`${green('Applied')} ${bold(template.id)}  ${template.title}`);
  printCreated(created, requireBoard(), 'new');
  out(dim(`  ${plural(created.length, 'document')} created`));
  return 0;
}
