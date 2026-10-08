/**
 * The GitHub provider's own slice of a remote declaration.
 *
 * Core validates the frame — that a remote has a `provider`, a scope, a
 * direction and two policies. This schema validates the contents of the
 * `connection` and `mapping` blocks for GitHub specifically, and is called
 * when the remote is opened (LP-259), exactly as `storage/views.ts` owns the
 * contents of a view file.
 *
 * GitHub has no native issue types, no custom fields and no workflow beyond
 * open/closed, so every board vocabulary element rides on labels:
 *
 *   - `types`      board type → `{ labels: [...] }`  (the labels that mark it)
 *   - `statuses`   board status id → the label(s) that carry it, plus which
 *                  one a push writes and whether the status closes the issue
 *   - `attributes` board attribute name → the label prefix that carries its
 *                  value (`story_points: 3` becomes the label `Points:3`)
 *   - `accounts`   `{ via: <attribute> }` — which resource attribute carries
 *                  the GitHub login (LP-271)
 *   - `periods`    which period level maps to the native carrier and which
 *                  carrier carries it — `{ container: <type>, carrier: milestones | iteration }`,
 *                  or the shorthand `milestones` / `iteration` (LP-313); the
 *                  other levels ride the managed block
 */

import { z } from 'zod';
import { normalizeStatusMappings, normalizeTypeMappings } from '../../mapping.js';

/**
 * GitHub repo coordinates as `owner/repo`. Loose on purpose — the only thing
 * that matters is that a repo is named, because there is no sensible default.
 */
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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
/**
 * One `mapping.statuses` value: a single remote state (`done: Done`), a list
 * (`done: [Done, "Won't Fix", Duplicate]`), or the full object form
 * (`done: { remote: [Done], push: Done, closed: true }`). The shape is
 * validated here; `normalizeStatusMappings` (in `mapping.ts`) expands every
 * spelling to the object form the engine reads.
 */
const statusEntrySchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
  z.object({
    remote: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    push: z.string().min(1).optional(),
    closed: z.boolean().optional(),
  }),
]);

export const githubConfigSchema = z.object({
  connection: z.object({
    /** `owner/repo` the remote issues live in. */
    repo: z
      .string({ error: 'connection.repo is required' })
      .min(1, 'connection.repo is required')
      .regex(repoPattern, 'must be "owner/repo"'),
    /**
     * API token, written as `${GITHUB_TOKEN}` or omitted. Omit and the
     * resolver (LP-295) looks it up in `.lpm/credentials.json`, then
     * `GITHUB_TOKEN`; the connector itself treats a missing token as an
     * unauthenticated request.
     */
    token: z.string().optional(),
    /** API root, e.g. a GitHub Enterprise host. Defaults to api.github.com. */
    base_url: z.string().optional(),
  }),
  mapping: z.object({
    /**
     * The Projects v2 Project this board's fields live in (LP-310), named
     * either by its number (`project: 7`) or by its title — never by its
     * `PVT_...` node id, which is what the resolver caches so nobody has to
     * read or write one. Absent means no Project is declared and Projects v2
     * is not used.
     */
    project: z
      .union([z.number().int().positive(), z.string().min(1)])
      .optional(),
    /**
     * Board field → Projects v2 field name (LP-310). Keys are board field
     * names — canonical fields (`status`, `title`) and declared attribute
     * names (`priority`, `story_points`) — and values are the Project field
     * names they live in, written in plain words so the config stays
     * readable. The resolver caches each value's node id (and, for a single
     * select, its option ids) so the sync addresses fields by id.
     */
    fields: z.record(z.string(), z.string().min(1)).default({}),
    /**
     * Which of GitHub's two "is it done" signals wins when they disagree
     * (LP-312). GitHub has two independent sources of truth for a board
     * status: the issue's own `state` (`open`/`closed`), and the Project
     * single-select column `fields.status` points at. They usually agree, but
     * a human can close an issue without moving the column (or move the column
     * without closing the issue). When they disagree on terminality:
     *
     *   - `issue`   (default) the issue state wins — a closed issue pulls
     *               back as the terminal status even when the column was not
     *               moved;
     *   - `project` the column wins — a column moved to a non-terminal value
     *               overrides a closed issue.
     *
     * Whichever side loses is reported as a discrepancy, never silently
     * dropped.
     */
    status_precedence: z.enum(['issue', 'project']).optional().default('issue'),
    types: z
      .record(z.string(), typeEntrySchema)
      .default({})
      .transform((entries) => normalizeTypeMappings(entries as Record<string, unknown>)),
    statuses: z
      .record(z.string(), statusEntrySchema)
      .default({})
      .transform((entries) => normalizeStatusMappings(entries as Record<string, unknown>)),
    attributes: z.record(z.string(), z.string()).default({}),
    accounts: z
      .object({
        /** Resource attribute whose value is the GitHub login. */
        via: z.string().min(1),
      })
      .optional(),
    periods: z
      .union([
        /** The shorthand: `periods: milestones` or `periods: iteration`. */
        z.enum(['milestones', 'iteration']),
        z.object({
          /** The period type that maps to the native carrier (`sprint`). */
          container: z.string().min(1),
          /**
           * The carrier: `milestones` (default) writes a repository milestone,
           * `iteration` writes a Project iteration field (LP-313). The
           * iteration field's name is `mapping.fields.period`.
           */
          carrier: z.enum(['milestones', 'iteration']).optional(),
        }),
      ])
      .optional()
      .transform((value) => {
        if (typeof value === 'string') return { carrier: value };
        return value;
      }),
  }),
});

/** The validated shape of a GitHub remote declaration. */
export type GithubConfig = z.infer<typeof githubConfigSchema>;

/** The `mapping` block, after validation (every sub-map present, statuses normalized). */
export type GithubMapping = GithubConfig['mapping'];
