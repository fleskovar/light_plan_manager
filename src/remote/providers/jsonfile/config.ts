/**
 * The jsonfile provider's own slice of a remote declaration.
 *
 * Core validates the frame — that a remote has a `provider`, a scope, a
 * direction and two policies. This schema validates the contents of the
 * `connection` and `mapping` blocks for the JSON-file tracker specifically,
 * and is called when the remote is opened (LP-259), exactly as the GitHub /
 * Linear / Jira schemas are.
 *
 * The JSON-file tracker has a native `type` field, a native `status` field and
 * a native `depends_on` edge list — it is the minimum a tracker can be. So the
 * mapping is the short one:
 *
 *   - `types`      board type → `{ type: <name> }` (the native type field),
 *                  plus optional `labels` — a human-readable type label, kept
 *                  alongside the native field so the sync's label claim still
 *                  has an exact label to reconcile (and a person reading the
 *                  file sees the type without knowing the vocabulary).
 *   - `statuses`   board status id → the native status name(s) plus whether the
 *                  status is terminal (`closed`). The status name *is* the
 *                  field value, exactly as Linear's workflow-state name is.
 *   - `attributes` board attribute name → the label prefix carrying its value
 *                  (rung 3) — the file has no typed custom-field registry.
 *
 * There is no `accounts` and no `periods` mapping: the file tracker holds an
 * arbitrary `assignee` string (which the account mapping could later resolve)
 * and no native period container, so both ride the ladder, not this schema.
 */

import { z } from 'zod';
import { normalizeStatusMappings, normalizeTypeMappings } from '../../mapping.js';

/**
 * One `mapping.types` value: the remote name this board type becomes, as a
 * bare string (`user_story: Story`) or the object form
 * (`user_story: { remote: Story }`). One name, not a list — a board type and
 * a remote type are one-to-one, unlike a status, where several remote states
 * can mean one board status.
 *
 * The superseded spellings (`type`, `labels`, and a list) are still accepted
 * and folded to the single name by `normalizeTypeMappings`, so a board written
 * against an older shape keeps working.
 */
const typeEntrySchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
  z.object({
    remote: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    type: z.string().min(1).optional(),
    labels: z.array(z.string().min(1)).min(1).optional(),
  }),
]);

/** One `mapping.statuses` value — the same three spellings the other providers accept. */
const statusEntrySchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
  z.object({
    remote: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    push: z.string().min(1).optional(),
    closed: z.boolean().optional(),
  }),
]);

export const jsonfileConfigSchema = z.object({
  connection: z.object({
    /**
     * The path to the JSON file that is the tracker. A missing file is an
     * empty tracker; the first sync creates it.
     */
    file: z
      .string({ error: 'connection.file is required' })
      .min(1, 'connection.file is required'),
  }),
  mapping: z.object({
    types: z
      .record(z.string(), typeEntrySchema)
      .default({})
      .transform((entries) => normalizeTypeMappings(entries as Record<string, unknown>)),
    statuses: z
      .record(z.string(), statusEntrySchema)
      .default({})
      .transform((entries) => normalizeStatusMappings(entries as Record<string, unknown>)),
    attributes: z.record(z.string(), z.string()).default({}),
  }),
});

/** The validated shape of a jsonfile remote declaration. */
export type JsonfileConfig = z.infer<typeof jsonfileConfigSchema>;

/** The `mapping` block, after validation. */
export type JsonfileMapping = JsonfileConfig['mapping'];

/** The `connection` block, after validation. */
export type JsonfileConnection = JsonfileConfig['connection'];
