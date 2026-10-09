import { z } from 'zod';
import { BoardError } from '../../core/index.js';
import { formatZodIssues } from '../../core/model/zod.js';
import type { ViewDocument } from '../../shared/index.js';
import {
  DEFAULT_DRAWER_HEIGHT,
  DEFAULT_PANEL_WIDTH,
  DEFAULT_QUEUE_WIDTH,
  VIEW_VERSION,
  emptyView,
} from '../../shared/index.js';

/**
 * The schema for a view file.
 *
 * Storage treats a view as opaque JSON, so this is the only place that knows
 * what is inside one. It is deliberately forgiving in the same spirit as
 * `load.ts`: a hand-edited or older view still opens, with anything missing
 * filled in from `emptyView`.
 */

const patchSchema = z
  .object({
    title: z.string().optional(),
    body: z.string().optional(),
    type: z.string().optional(),
    parentId: z.string().nullable().optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    status: z.string().optional(),
    assignee: z.string().nullable().optional(),
    period: z.string().nullable().optional(),
    dependsOn: z.array(z.string()).optional(),
    relatesTo: z.array(z.string()).optional(),
    relatedFiles: z.array(z.string()).optional(),
    /** Templates only: what the registry says this template is for. */
    description: z.string().optional(),
    /** Templates only: the parameters it asks for, as declared. */
    params: z
      .record(
        z.string(),
        z.object({
          type: z.enum(['string', 'text', 'int', 'float', 'bool', 'date', 'enum', 'array']),
          description: z.string().optional(),
          required: z.boolean().optional(),
          default: z.unknown().optional(),
          values: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    starts: z.string().optional(),
    ends: z.string().optional(),
    // Nullable as well as optional: null is "back on the dates", which is a
    // different queued edit from never having touched the switch.
    active: z.boolean().nullable().optional(),
    capacity: z.number().optional(),
    covers: z.array(z.string()).optional(),
    /** Periods only: squad that owns this period; null to clear. */
    squad: z.string().nullable().optional(),
    /** Squads only: resource ids belonging to this squad. */
    members: z.array(z.string()).optional(),
  })
  .strict();

const nodeKindSchema = z.enum(['issue', 'period', 'resource', 'squad', 'template']);

const changeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create'),
    id: z.string(),
    nodeKind: nodeKindSchema,
    patch: patchSchema,
  }),
  z.object({
    kind: z.literal('update'),
    id: z.string(),
    nodeKind: nodeKindSchema,
    patch: patchSchema,
  }),
  z.object({ kind: z.literal('delete'), id: z.string(), nodeKind: nodeKindSchema }),
]);

const layoutSchema = z.object({
  x: z.number(),
  y: z.number(),
  collapsed: z.boolean().optional(),
  // A hand-dragged size. Optional because most nodes never get one.
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});

const viewSchema = z.object({
  version: z.number().int().positive().default(VIEW_VERSION),
  id: z.string().min(1),
  name: z.string().min(1),
  created: z.string().optional(),
  updated: z.string().optional(),
  members: z.array(z.string()).default([]),
  layout: z.record(z.string(), layoutSchema).default({}),
  changes: z.array(changeSchema).default([]),
  drawer: z
    .object({
      open: z.boolean().default(true),
      // `queue` was a tab before the queue became a panel of its own; a view
      // saved on it opens on the table, and the panel shows the queue.
      tab: z
        .enum(['table', 'gantt', 'team', 'periods', 'queue', 'sync'])
        .transform((tab) => (tab === 'queue' ? 'table' : tab))
        .default('table'),
      height: z.number().min(0).default(DEFAULT_DRAWER_HEIGHT),
    })
    .default({ open: true, tab: 'table', height: DEFAULT_DRAWER_HEIGHT }),
  panel: z
    .object({
      open: z.boolean().default(false),
      pinned: z.boolean().default(false),
      width: z.number().min(0).default(DEFAULT_PANEL_WIDTH),
    })
    .default({ open: false, pinned: false, width: DEFAULT_PANEL_WIDTH }),
  queue: z
    .object({
      open: z.boolean().default(true),
      width: z.number().min(0).default(DEFAULT_QUEUE_WIDTH),
    })
    .default({ open: true, width: DEFAULT_QUEUE_WIDTH }),
  // Levels the canvas draws as a badge on their children rather than as nodes.
  display: z.record(z.string(), z.enum(['node', 'badge'])).default({}),
  // Planning with the calendar, or straight off the queue.
  planning: z.enum(['periods', 'queue']).default('periods'),
  // A canvas over the board, or over the template registry. A view written
  // before this existed is a board view, which is what every one of them was.
  mode: z.enum(['board', 'templates']).default('board'),
});

export function parseView(raw: unknown, id: string): ViewDocument {
  const result = viewSchema.safeParse(raw);
  if (!result.success) {
    throw new BoardError(
      `View "${id}" is not a valid view file`,
      formatZodIssues(result.error),
    );
  }
  const fallback = emptyView(id, result.data.name);
  return {
    ...fallback,
    ...result.data,
    // The filename is the id; a mismatched one inside the file loses.
    id,
    created: result.data.created ?? fallback.created,
    updated: result.data.updated ?? fallback.updated,
  };
}
