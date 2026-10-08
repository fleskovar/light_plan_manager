import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnyNode, Issue } from '../../core/index.js';
import {
  checkBoard,
  describeScope,
  findNode,
  inScope,
  instructionsFor,
  isGenericResource,
  isPeriodOverdue,
  isTemplateRoot,
  listComments,
  listContextTemplates,
  nodesOf,
  periodStance,
  rolledUpDependenciesOf,
  rolledUpDependentsOf,
  subtreeOf,
  workUnits,
} from '../../core/index.js';
import { ancestorsOf, dependentsOf } from '../../shared/index.js';
import { toSnapshot } from '../../sync/index.js';
import type { BoardContext } from '../context.js';
import { guard, json } from '../reply.js';

/**
 * Reading the board.
 *
 * These are the tools an agent should reach for first: what kinds of documents
 * this board has, what is on it, and everything about one of them. The engine's
 * own vocabulary is exposed rather than flattened, because a board defines its
 * own types and statuses and an agent has to plan in those terms.
 */
/**
 * Ids of the documents nothing is nested inside. `atomic` is an issue-tree idea,
 * so periods and resources keep the plain rule.
 */
function parentlessIds(nodes: { id: string; parentId: string | null }[]): Set<string> {
  const parents = new Set(nodes.map((node) => node.parentId));
  return new Set(nodes.filter((node) => !parents.has(node.id)).map((node) => node.id));
}

export function registerReadTools(server: McpServer, context: BoardContext): void {
  server.registerTool(
    'board_overview',
    {
      title: 'Board overview',
      description:
        'The shape of this board: its document types and the hierarchy they nest in, its ' +
        'statuses, whether it tracks time and people, and how much of each it holds. Call ' +
        'this first — every other tool speaks in the type and status names it returns.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(() => {
      const board = context.board();
      const snapshot = toSnapshot(board);
      const { config } = snapshot;
      const scope = context.scope(board);

      return json({
        board: config.boardName,
        hierarchy: config.hierarchy,
        types: Object.values(config.types).map((type) => ({
          name: type.name,
          kind: type.kind,
          label: type.label,
          depth: type.depth,
          generic: type.generic || undefined,
          attributes: type.attributes.map((attribute) => ({
            name: attribute.name,
            type: attribute.type,
            values: attribute.values,
            description: attribute.description,
          })),
        })),
        statuses: config.statuses,
        defaultStatus: config.defaultStatus,
        priorityAttribute: config.priorityAttribute || null,
        effortAttribute: config.effortAttribute || null,
        hasSquads: config.hasSquads || undefined,
        counts: {
          issues: snapshot.issues.length,
          periods: snapshot.periods.length,
          resources: snapshot.resources.length,
          ...(config.hasSquads ? { squads: snapshot.squads.length } : {}),
          templates: snapshot.templates.filter((template) => template.root).length,
        },
        currentUser: context.user(board)?.id ?? null,
        readOnly: context.readOnly,
        // What this session is offered. Stated up front so an agent never has
        // to wonder why a list looks short — and so it knows the board holds
        // more than it is being handed.
        scope: describeScope(scope),
        scopeWarnings: [
          ...context.profileErrors,
          ...scope.unknown.map((name) => `this board has nothing named "${name}"`),
        ],
        problems: snapshot.problems.length,
      });
    }),
  );

  server.registerTool(
    'list_documents',
    {
      title: 'List documents',
      description:
        'Issues, periods or resources, filtered. Returns a flat list with parent ids, so the ' +
        'tree can be rebuilt from it. Use `get_document` for one document in full. If this ' +
        'session has a scope (see `board_overview`), issues outside it are left out and ' +
        'counted in `outOfScope`.',
      inputSchema: {
        kind: z.enum(['issue', 'period', 'resource', 'squad', 'template']).default('issue'),
        type: z.string().optional().describe('Only this document type'),
        status: z.string().optional().describe('Issues only'),
        assignee: z.string().optional().describe('Issues only; a resource id'),
        period: z.string().optional().describe('Issues only; a period id'),
        parent: z.string().optional().describe('Only children of this document'),
        under: z.string().optional().describe('Everything nested below this document'),
        workUnitsOnly: z
          .boolean()
          .optional()
          .describe(
            'Only the documents that carry work: issues with no children, plus ' +
              'any whose type the board declares `atomic` (taken whole, so what ' +
              'is nested inside them is their own checklist and is left out)',
          ),
        search: z.string().optional().describe('Match against title, id and body'),
        limit: z.number().int().positive().max(500).default(200),
      },
      annotations: { readOnlyHint: true },
    },
    guard((args) => {
      const board = context.board();
      const kind = args.kind ?? 'issue';
      // `nodesOf` is kind-parameterized and returns the common shape; the kind
      // is what says which of the three it really is.
      let nodes = nodesOf(board, kind) as AnyNode[];

      if (args.under) {
        const root = findNode(board, args.under);
        if (root) nodes = subtreeOf(nodes, root as AnyNode).filter((node) => node.id !== root.id);
        else nodes = [];
      }
      if (args.parent) nodes = nodes.filter((node) => node.parentId === args.parent);
      if (args.type) nodes = nodes.filter((node) => node.type === args.type);
      if (args.workUnitsOnly) {
        // Derived from the whole board, never from `nodes` — narrowing by
        // `parent` or `type` first would leave every survivor looking childless.
        const carriers =
          kind === 'issue'
            ? new Set(workUnits(board).map((issue) => issue.id))
            : parentlessIds(nodesOf(board, kind));
        nodes = nodes.filter((node) => carriers.has(node.id));
      }
      if (args.search) {
        const needle = args.search.toLowerCase();
        nodes = nodes.filter(
          (node) =>
            node.title.toLowerCase().includes(needle) ||
            node.id.toLowerCase().includes(needle) ||
            node.body.toLowerCase().includes(needle),
        );
      }
      let outOfScope = 0;
      if (kind === 'issue') {
        const issues = nodes as Issue[];
        nodes = issues.filter(
          (issue) =>
            (!args.status || issue.status === args.status) &&
            (!args.assignee || issue.assignee === args.assignee) &&
            (!args.period || issue.period === args.period),
        );
        // The session's profile, if it has one. Reported rather than silent:
        // a short list nobody can explain is worse than a short list.
        const scope = context.scope(board);
        if (scope.active) {
          const before = nodes.length;
          nodes = (nodes as Issue[]).filter((issue) => inScope(scope, issue));
          outOfScope = before - nodes.length;
        }
      }

      return json({
        total: nodes.length,
        ...(outOfScope ? { outOfScope } : {}),
        documents: nodes.slice(0, args.limit ?? 200).map((node) => ({
          id: node.id,
          type: node.type,
          title: node.title,
          parentId: node.parentId,
          depth: node.depth,
          // Included so an agent can rank by effort or priority without
          // fetching every document one at a time.
          attributes: node.attributes,
          ...(node.kind === 'issue'
            ? {
                status: node.status,
                assignee: node.assignee,
                period: node.period,
                dependsOn: node.depends_on,
                // Only when set, so an unflagged board is not a wall of nulls.
                ...(node.flag ? { flag: node.flag } : {}),
              }
            : node.kind === 'squad'
              ? { members: node.members }
              : {}),
          ...(node.kind === 'period'
            ? { starts: node.starts, ends: node.ends, running: periodStance(board, node) }
            : {}),
          ...(node.kind === 'resource'
            ? { capacity: node.capacity, generic: isGenericResource(board, node) }
            : {}),
        })),
      });
    }),
  );

  server.registerTool(
    'get_document',
    {
      title: 'Get a document',
      description:
        'One document in full: its fields, attributes, markdown body, where it sits, what it ' +
        'blocks and is blocked by, its children, and its comment log. This is what to read ' +
        'before changing anything. To *do* an issue rather than edit it, call ' +
        '`get_instructions` instead — it returns this document together with the ancestors ' +
        'that explain why it exists, already laid out to work from.',
      inputSchema: {
        id: z.string().describe('An issue, period or resource id'),
        includeComments: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true },
    },
    guard((args) => {
      const board = context.board();
      const node = findNode(board, args.id);
      if (!node) throw new Error(`No issue, period or resource with id "${args.id}"`);

      const view = context.view(board);
      const children = nodesOf(board, node.kind).filter((other) => other.parentId === node.id);

      return json({
        id: node.id,
        kind: node.kind,
        type: node.type,
        title: node.title,
        parentId: node.parentId,
        depth: node.depth,
        ancestors: ancestorsOf(view, node.id).map((entry) => entry.id),
        children: children.map((child) => ({ id: child.id, title: child.title, type: child.type })),
        attributes: node.attributes,
        body: node.body,
        created: node.created,
        updated: node.updated,
        author: node.author,
        ...(node.kind === 'issue'
          ? {
              status: node.status,
              assignee: node.assignee,
              period: node.period,
              // Null unless somebody stopped work on this and said why; the
              // reason is in the comment log below.
              flag: node.flag,
              blockedBy: node.depends_on,
              blocks: dependentsOf(view, node.id).map((issue) => issue.id),
              // What the work inside this puts it after, and what it puts
              // after this: a dependency between two stories puts the two
              // features they sit in in the same order, up to the container
              // they share. Read off the graph, never written on a document —
              // a `depends_on` on a container is inherited by everything
              // inside it, which would stop work that waits on nothing.
              rolledUpBlockedBy: rolledUpDependenciesOf(board, node.id).map((entry) => ({
                id: entry.to,
                because: { blocked: entry.source, blockedBy: entry.target },
              })),
              rolledUpBlocks: rolledUpDependentsOf(board, node.id).map((entry) => ({
                id: entry.from,
                because: { blocked: entry.source, blockedBy: entry.target },
              })),
              relatesTo: node.relates_to,
              // Files this issue is about, as written on it: a requirement to
              // read, source to change. Paths from the project root, sometimes
              // with a line range. Not verified against the filesystem.
              relatedFiles: node.related_files,
            }
          : {}),
        ...(node.kind === 'period'
          ? {
              starts: node.starts,
              ends: node.ends,
              // 'auto' means the dates decide, which is the ordinary answer.
              running: periodStance(board, node),
              overdue: isPeriodOverdue(board, node, new Date().toISOString().slice(0, 10)),
            }
          : {}),
        ...(node.kind === 'resource'
          ? {
              capacity: node.capacity,
              covers: node.covers,
              generic: isGenericResource(board, node),
            }
          : {}),
        ...(node.kind === 'template'
          ? {
              description: node.description,
              params: node.params,
              root: isTemplateRoot(board, node),
              dependsOn: node.depends_on,
              relatedFiles: node.related_files,
            }
          : {}),
        comments: args.includeComments === false ? undefined : listComments(board, node.id),
      });
    }),
  );

  server.registerTool(
    'get_instructions',
    {
      title: 'Get the working brief for an issue',
      description:
        'Everything you need to start one issue, as a single piece of markdown: the issue ' +
        'itself, the titles and bodies of every document above it in the hierarchy (the epic ' +
        'and feature it belongs to, whatever this board calls them), its breakdown, what it ' +
        'is blocked by, the research it rests on, and its work log. ' +
        'Call this after `start_task` and read it before writing any code — `get_document` ' +
        'gives you one document, this gives you the reason it exists. ' +
        'The layout comes from the board (.lpm/templates/context), so a team can decide what ' +
        'its developers are told; pass `template` only if you were asked to use a specific one. ' +
        'If this returns an error saying a template was refused, do not try to work around it: ' +
        'report it. It means the board carries a layout that can run code outside the board, ' +
        'which a human needs to look at.',
      inputSchema: {
        id: z.string().describe('An issue id'),
        template: z
          .string()
          .optional()
          .describe('A template name from this board, or a path to a markdown file'),
        includeComments: z
          .boolean()
          .default(true)
          .describe('Include the issue’s work log. Leave it on unless the brief is too long'),
      },
      annotations: { readOnlyHint: true },
    },
    guard((args) => {
      const board = context.board();
      // Deliberately no `allowUnsafe` here, and no input that could set one: a
      // template that can escape must be somebody's decision at a keyboard,
      // never an agent's.
      const brief = instructionsFor(board, args.id, {
        template: args.template,
        includeComments: args.includeComments !== false,
      });
      return json({
        id: brief.issue.id,
        type: brief.issue.type,
        title: brief.issue.title,
        status: brief.issue.status,
        // Where the layout came from, so an agent can say which brief it read.
        template: brief.source.path ?? 'built-in',
        instructions: brief.text,
        // Sections the template asked for that this board could not fill in.
        // Usually a template naming a type or attribute this board lacks.
        warnings: brief.warnings,
        // Anything the safety check saw in the layout. A `danger` never reaches
        // here (it refuses instead), so these are things worth mentioning to a
        // human rather than acting on.
        templateFindings: brief.findings,
        availableTemplates: listContextTemplates(board.paths),
      });
    }),
  );

  server.registerTool(
    'check_board',
    {
      title: 'Check the board',
      description:
        'Validate the whole board and report every problem: broken references, dependency ' +
        'cycles, hierarchy violations, periods that do not fit. Worth calling after a batch ' +
        'of structural changes.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(() => {
      const problems = checkBoard(context.board());
      return json({
        errors: problems.filter((problem) => problem.level === 'error').length,
        warnings: problems.filter((problem) => problem.level === 'warn').length,
        problems,
      });
    }),
  );
}
