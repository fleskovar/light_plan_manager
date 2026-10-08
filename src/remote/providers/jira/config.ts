/**
 * The Jira provider's own slice of a remote declaration.
 *
 * Core validates the frame — that a remote has a `provider`, a scope, a
 * direction and two policies. This schema validates the contents of the
 * `connection` and `mapping` blocks for Jira Cloud specifically, and is called
 * when the remote is opened (LP-259), exactly as `storage/views.ts` owns the
 * contents of a view file.
 *
 * Jira Cloud has *native* issue types, workflow statuses (transition-mediated)
 * and custom fields, so the mapping names them rather than encoding them onto
 * labels:
 *
 *   - `types`      board type → the Jira issuetype name (`{ type: Story }`)
 *   - `statuses`   board status id → the Jira status name(s) a push targets,
 *                  plus whether the status is terminal (`closed`) — the flag
 *                  that lets the sync tell a finished column from an open one
 *   - `attributes` board attribute name → the Jira custom field id that
 *                  carries it (`customfield_10016`). Resolving a *name* to an
 *                  id is LP-324's discovery, not this schema's: the mapping
 *                  names the id the instance actually has.
 *   - `accounts`   `{ via: <attribute> }` — which resource attribute carries
 *                  the Jira account (LP-271, LP-329). `via: email` resolves
 *                  through Jira's user search and is refused with the
 *                  `jira_account_id` alternative on a privacy-restricted
 *                  instance; `via: jira_account_id` (or any other attribute)
 *                  holds the account id and is used directly, no search.
 *   - `periods`    `{ container: <period type> }` — which period level maps to
 *                  a Jira sprint (LP-328); the other levels ride labels
 *   - `transitions` `{ multi_hop: <bool> }` — whether a status change may walk
 *                  the workflow several transitions (LP-326); off by default
 *   - `transition_fields` field key → value, the answers for transition
 *                  screens whose fields are required (a resolution, a reason)
 *
 * The connection block carries the Cloud site, the project key and the agile
 * board id (enables sprint mapping), plus the identity resolved through the
 * credential chain — `email` and `token` name *where* the secret comes from,
 * never the secret itself (LP-290).
 */

import { z } from 'zod';
import { normalizeStatusMappings, normalizeTypeMappings } from '../../mapping.js';

/**
 * The Cloud site URL. Accepts `https://<org>.atlassian.net` and a Cloud site
 * on a custom domain (`https://jira.acme.com`) — the two shapes Cloud serves.
 * A Server/Data Center URL is indistinguishable from a custom domain by URL
 * alone, so it is not refused here; the connector reports it with a clear
 * "not supported" when the Cloud API turns out not to be there.
 */
const siteSchema = z
  .string({ error: 'connection.site is required' })
  .min(1, 'connection.site is required')
  .refine((value) => /^https:\/\/[^/\s]+/.test(value.trim()), {
    message: 'must be an https URL, e.g. https://acme.atlassian.net',
  })
  .refine(
    (value) => {
      try {
        return new URL(value.trim()).hostname.length > 0;
      } catch {
        return false;
      }
    },
    { message: 'must be an https URL with a host' },
  );

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
 * One `mapping.statuses` value, the same three spellings GitHub accepts: a
 * single remote state, a list, or the full object form with `push` and
 * `closed`. For Jira the names are workflow status names ("In Progress",
 * "Done"); `normalizeStatusMappings` expands every spelling to the object form
 * the engine reads.
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

export const jiraConfigSchema = z.object({
  connection: z.object({
    /** The Cloud site the project lives on. */
    site: siteSchema,
    /** The project key issues are filed into (e.g. `PAY`). */
    project: z
      .string({ error: 'connection.project is required' })
      .min(1, 'connection.project is required')
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'must be the Jira project key, e.g. PAY'),
    /**
     * Agile board id; enables sprint mapping (LP-328). A number in YAML, or a
     * numeric string — both are the same id.
     */
    board: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)])
      .optional()
      .transform((value) => (value === undefined ? undefined : String(value))),
    /**
     * The account email, written as `${JIRA_EMAIL}` or omitted. Omit and the
     * resolver (LP-295) looks it up in `.lpm/credentials.json`, then
     * `JIRA_EMAIL`.
     */
    email: z.string().optional(),
    /**
     * The API token, written as `${JIRA_API_TOKEN}` or omitted. Omit and the
     * resolver looks it up in `.lpm/credentials.json`, then `JIRA_API_TOKEN`.
     */
    token: z.string().optional(),
    /**
     * Explicitly disable TLS verification. Defaults to absent — verification
     * is on and stays on. A corporate MITM proxy is handled by OS trust-store
     * injection (NODE_EXTRA_CA_CERTS, `--use-system-ca`); this is the loud,
     * never-default fallback.
     */
    tls_verify: z.boolean().optional(),
  }),
  mapping: z.object({
    /** Board type → the Jira issuetype name it becomes. */
    types: z
      .record(z.string(), typeEntrySchema)
      .default({})
      .transform((entries) => normalizeTypeMappings(entries as Record<string, unknown>)),
    /** Board status id → the Jira workflow status name(s) and terminal flag. */
    statuses: z
      .record(z.string(), statusEntrySchema)
      .default({})
      .transform((entries) => normalizeStatusMappings(entries as Record<string, unknown>)),
    /**
     * How a status change is applied (LP-326). `multi_hop` opts in to walking
     * the workflow several transitions to reach a status with no direct hop;
     * it is off by default because transitions fire automations, notify people
     * and stamp resolutions — the decision is the operator's, not the sync's.
     */
    transitions: z
      .object({
        multi_hop: z.boolean().optional(),
      })
      .optional()
      .default({}),
    /**
     * Values for transition screens, keyed by the Jira field key a transition
     * requires (`resolution`, `customfield_10016`). A transition whose screen
     * requires a field is satisfied from here; a required field with no entry
     * is refused with the field named rather than guessed.
     */
    transition_fields: z.record(z.string(), z.unknown()).optional().default({}),
    /** Board attribute name → the Jira custom field id carrying it. */
    attributes: z.record(z.string(), z.string().min(1)).default({}),
    accounts: z
      .object({
        /** Resource attribute whose value is the Jira account id. */
        via: z.string().min(1),
      })
      .optional(),
    /**
     * How the board's parent chain is carried (LP-309): `sub-issues` uses the
     * remote's native parent edge where the depth allows, `labels` puts every
     * parent in the managed block.
     *
     * Worth setting on a **team-managed** project, where the answer depends on
     * the *types* rather than the depth: only a standard issue may sit under an
     * Epic, and an Epic may not sit under anything. A board with three levels
     * above its stories maps them all onto `Epic`, and Jira then refuses the
     * native parent for each of them ("Please select valid parent issue") —
     * `hierarchy: labels` files the whole chain in the block instead, which is
     * lossless and round-trips. Absent means the encoding is resolved from the
     * project's own probed depth, which is right for a company-managed project
     * with a real type hierarchy.
     */
    hierarchy: z.enum(['sub-issues', 'labels']).optional(),
    periods: z
      .object({
        /** The period type that maps to a Jira sprint (`sprint`). */
        container: z.string().min(1),
      })
      // Jira's only native container is a sprint, so the carrier is fixed —
      // the transform stamps it so `openRemote` / `normalizePeriodMapping`
      // downstream see `carrier: 'sprint'` rather than the GitHub default.
      .transform((value) => ({ container: value.container, carrier: 'sprint' as const }))
      .optional(),
  }),
});

/** The validated shape of a Jira remote declaration. */
export type JiraConfig = z.infer<typeof jiraConfigSchema>;

/** The `mapping` block, after validation. */
export type JiraMapping = JiraConfig['mapping'];

/** The `connection` block, after validation (defaults applied, board stringified). */
export type JiraConnection = JiraConfig['connection'];
