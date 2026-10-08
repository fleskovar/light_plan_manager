import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  BoardError,
  findNode,
  isTemplateRoot,
  requireTemplate,
  templatePath,
  templateSubtree,
  validateAttributeValue,
} from '../../core/index.js';
import { planInstantiate } from '../../shared/index.js';
import type { BoardContext } from '../context.js';
import { guard, json } from '../reply.js';

/**
 * The template registry, as an agent sees it.
 *
 * These are the tools that answer "has somebody already worked out how to do
 * this?" before anything is written. A registry that nobody consults is a
 * folder of dead documents, so `list_templates` is deliberately cheap to call
 * and returns enough — the description and the shape — to decide without a
 * second round trip.
 */
export function registerTemplateTools(server: McpServer, context: BoardContext): void {
  server.registerTool(
    'list_templates',
    {
      title: 'List reusable templates',
      description:
        'The template registry: reusable pieces of plan somebody has already worked out — a ' +
        'feature with its standard stories, a release checklist, the steps a particular kind ' +
        'of change has to go through. **Call this before creating documents by hand**: if a ' +
        'template covers what you are about to write, instantiating it is both faster and the ' +
        'process this team has agreed on. Returns what each one is for, what it asks for, and ' +
        'how many documents it would create.',
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe('Match against the title, the description and the type'),
        all: z
          .boolean()
          .default(false)
          .describe('Include folders and the documents nested inside templates'),
      },
      annotations: { readOnlyHint: true },
    },
    guard((args) => {
      const board = context.board();
      const wanted = args.search?.trim().toLowerCase();

      const entries = board.templates
        .filter((template) => args.all || isTemplateRoot(board, template))
        .filter((template) => {
          if (!wanted) return true;
          return [template.title, template.description, template.type, template.id]
            .join(' ')
            .toLowerCase()
            .includes(wanted);
        })
        .map((template) => ({
          id: template.id,
          type: template.type,
          title: template.title,
          description: template.description,
          folder: templatePath(board, template).join(' / ') || null,
          root: isTemplateRoot(board, template),
          creates: templateSubtree(board, template).length,
          params: Object.entries(template.params).map(([name, def]) => ({
            name,
            type: def.type,
            required: def.required ?? false,
            default: def.default,
            values: def.values,
            description: def.description,
          })),
        }));

      return json({
        templates: entries,
        total: entries.length,
        hint: entries.length
          ? 'Use get_template for the full shape, then instantiate_template with a params object.'
          : 'The registry is empty; create documents directly.',
      });
    }),
  );

  server.registerTool(
    'get_template',
    {
      title: 'Read one template',
      description:
        'Everything about one registry template: what it is for, every parameter it asks for ' +
        'with its type and default, and the whole tree of documents it would create, with the ' +
        'dependencies between them. Read this before instantiating so you know what the ' +
        'parameters mean and what will land on the board.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    guard((args) => {
      const board = context.board();
      const template = requireTemplate(board, args.id);

      return json({
        id: template.id,
        type: template.type,
        title: template.title,
        description: template.description,
        folder: templatePath(board, template).join(' / ') || null,
        root: isTemplateRoot(board, template),
        params: Object.entries(template.params).map(([name, def]) => ({
          name,
          type: def.type,
          required: def.required ?? false,
          default: def.default,
          values: def.values,
          description: def.description,
        })),
        creates: templateSubtree(board, template).map((node) => ({
          type: node.type,
          title: node.title,
          depth: node.depth - template.depth,
          parentId: node.parentId,
          templateId: node.id,
          dependsOn: node.depends_on,
          body: node.body,
          attributes: node.attributes,
          relatedFiles: node.related_files,
        })),
      });
    }),
  );

  server.registerTool(
    'instantiate_template',
    {
      title: 'Create documents from a template',
      description:
        'Copy a registry template onto the board, filling in its parameters. Every document ' +
        'in the template is created, the dependencies between them are repointed at the new ' +
        'issues, and {{parameters}} in titles, bodies, related files and attributes are ' +
        'replaced with the values you pass. Pass the parameters as a JSON object — ' +
        '`get_template` says which are required. Use `dryRun` to see what would land first.',
      inputSchema: {
        id: z.string().describe('The template id, from list_templates'),
        params: z
          .record(z.string(), z.unknown())
          .default({})
          .describe('Parameter values by name, as a JSON object'),
        parent: z
          .string()
          .nullable()
          .optional()
          .describe('Issue to create it under; omit or null for the top level'),
        period: z.string().optional().describe('Schedule everything it creates into this period'),
        assignee: z.string().optional().describe('Assign everything it creates'),
        status: z.string().optional().describe("Status for the issues created; the board's by default"),
        dryRun: z.boolean().default(false).describe('Report what would happen, change nothing'),
      },
    },
    guard((args) => {
      const board = context.board();
      const template = requireTemplate(board, args.id);
      if (args.parent && !findNode(board, args.parent)) {
        throw new BoardError(`No document with id "${args.parent}"`);
      }

      const plan = planInstantiate(context.view(board), context.ids(), template.id, {
        parentId: args.parent ?? null,
        params: args.params,
        period: args.period,
        assignee: args.assignee,
        status: args.status,
        validate: validateAttributeValue,
      });

      if (args.dryRun) {
        if (!plan.ok) throw new BoardError(plan.error, plan.details);
        return json({
          wouldCreate: plan.changes
            .filter((change) => change.kind === 'create')
            .map((change) => ({
              type: change.patch.type,
              title: change.patch.title,
            })),
          from: template.id,
        });
      }

      const { created } = context.run(plan);
      return json({ instantiated: template.id, created, under: args.parent ?? null });
    }),
  );
}
