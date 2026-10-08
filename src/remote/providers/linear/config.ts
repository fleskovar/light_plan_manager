/**
 * The Linear provider's own slice of a remote declaration.
 *
 * Core validates the frame — that a remote has a `provider`, a scope, a
 * direction and two policies. This schema validates the contents of the
 * `connection` and `mapping` blocks for Linear specifically, and is called
 * when the remote is opened (LP-259), exactly as `storage/views.ts` owns the
 * contents of a view file.
 *
 * Linear has native workflow states, native relations, native cycles and a
 * native assignee — but **no issue types** and **no custom fields** (LP-267).
 * So the mapping is a split: types ride labels (rung 3, exactly as GitHub),
 * statuses name Linear workflow states, and every board attribute beyond the
 * fixed fields rides labels or the managed block (rung 3/4). The fixed fields
 * themselves — `estimate` (the effort attribute) and `priority` (0–4) — are
 * LP-333's work; `effort` below names the effort attribute, and `priority`
 * remains fixed to Linear's 0–4 scale (note 4 of the capability matrix).
 *
 *   - `types`      board type → `{ labels: [...] }` (Linear has no native type)
 *   - `statuses`   board status id → the Linear workflow state name(s) plus
 *                  which one a push writes and whether it is terminal
 *   - `effort`     `{ attribute: <name> }` — which board attribute maps to
 *                  Linear's native `estimate` (LP-333). The value is checked
 *                  against the team's estimation scale at preflight, never
 *                  silently rounded.
 *   - `attributes` board attribute name → the label prefix carrying its value
 *   - `accounts`   `{ via: <attribute> }` — which resource attribute carries
 *                  the Linear account (an email, a Linear user id or a name)
 *   - `periods`    which period level maps to a Linear cycle — the carrier is
 *                  fixed to `sprint`, the cycle's counterpart (LP-334)
 *
 * Everything in Linear is team-scoped, so the connection block names the team:
 * `team` is the team key (or id), and every query carries it.
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

/** One `mapping.statuses` value — the same three spellings GitHub and Jira accept. */
const statusEntrySchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
  z.object({
    remote: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    push: z.string().min(1).optional(),
    closed: z.boolean().optional(),
  }),
]);

export const linearConfigSchema = z.object({
  connection: z.object({
    /**
     * The team key (e.g. `ENG`) or id. Everything Linear holds — states,
     * labels, cycles, the estimation scale — is team-scoped, so the team is
     * the one coordinate every query carries (LP-330).
     */
    team: z
      .string({ error: 'connection.team is required' })
      .min(1, 'connection.team is required'),
    /**
     * The API key, written as `${LINEAR_API_KEY}` or omitted. Omit and the
     * resolver (LP-295) looks it up in `.lpm/credentials.json`, then
     * `LINEAR_API_KEY`.
     */
    api_key: z.string().optional(),
    /** API root, for a self-hosted or proxied Linear. Defaults to api.linear.app. */
    base_url: z.string().optional(),
  }),
  mapping: z.object({
    /** Board type → the label(s) that mark it (Linear has no native type). */
    types: z
      .record(z.string(), typeEntrySchema)
      .default({})
      .transform((entries) => normalizeTypeMappings(entries as Record<string, unknown>)),
    /** Board status id → the Linear workflow state name(s) and terminal flag. */
    statuses: z
      .record(z.string(), statusEntrySchema)
      .default({})
      .transform((entries) => normalizeStatusMappings(entries as Record<string, unknown>)),
    /**
     * The board attribute that maps to Linear's native `estimate` (LP-333).
     * The value rides the issue's `estimate` field (rung 1), not a label;
     * `mapping.attributes` must not also map it. A value outside the team's
     * estimation scale is reported at preflight with the allowed values.
     */
    effort: z
      .object({
        attribute: z.string().min(1),
      })
      .optional(),
    /** Board attribute name → the label prefix carrying its value. */
    attributes: z.record(z.string(), z.string()).default({}),
    accounts: z
      .object({
        /** Resource attribute whose value is the Linear account. */
        via: z.string().min(1),
      })
      .optional(),
    periods: z
      .object({
        /**
         * The period type that maps to a Linear cycle (`sprint`).
         *
         * Cycles are time-boxed and *numbered* rather than named — Linear
         * auto-titles them `Cycle 1`, `Cycle 2`, … — so a period is matched to
         * a cycle by name, and the convention is the one thing a team must
         * agree on: the period's title **is** the cycle's name (`Cycle 12` ↔
         * a period titled `Cycle 12`). Renaming a cycle in Linear breaks the
         * match; re-title the period to follow (LP-334).
         */
        container: z.string().min(1),
      })
      // Linear's only native period container is a cycle, and a cycle is the
      // sprint counterpart — the carrier is stamped so `openRemote` /
      // `normalizePeriodMapping` downstream see `carrier: 'sprint'` rather
      // than the GitHub milestone default. The level above the cycle rides the
      // managed block as a `period:<type>` row (LP-334); a Linear project
      // mapping for that level is a separate, optional config surface.
      .transform((value) => ({ container: value.container, carrier: 'sprint' as const }))
      .optional(),
  }),
});

/** The validated shape of a Linear remote declaration. */
export type LinearConfig = z.infer<typeof linearConfigSchema>;

/** The `mapping` block, after validation. */
export type LinearMapping = LinearConfig['mapping'];

/** The `connection` block, after validation. */
export type LinearConnection = LinearConfig['connection'];
