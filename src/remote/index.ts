/**
 * Remote sync layer.
 *
 * Knows how to mirror an `.lpm` board onto an external tracker and back.  Sits
 * above the engine, beside `src/sync`: it may import `src/core`, `src/shared`
 * and `src/sync`, and nothing in `src/core` may import it.
 *
 * The *reasoning* behind the choices this folder makes — why the link store
 * rather than a frontmatter field, why the base snapshot, the degradation
 * ladder, pull-as-push, and the two-connector split — is the design record,
 * `docs/remote-sync.md`. This comment and that document are the two things
 * that keep a provider from growing reshaping logic.
 *
 *   links.ts       the correspondence store — which document is which remote issue
 *   managed-block.ts the rung-4 codec: write fields into the body idempotently
 *                  and parse them back out (LP-276, LP-277)
 *   managed-comment.ts the rung-5 codec: the same block as a comment when the
 *                  body is not writable (LP-278)
 *   remotes.ts     declared remotes from config (LP-252)
 *   scope.ts       which subtree a remote mirrors, and nothing else (LP-261)
 *   shape.ts       hierarchy/type divergence report — reparent, retype, scope
 *                  exit — reported, never silently applied (LP-368)
 *   lifecycle.ts   the state of each correspondence (LP-361)
 *   adopt.ts       adopt an existing remote issue into a document, and read
 *                  the managed-block pairing a re-cloned board offers (LP-367)
 *   mapping.ts     board vocabulary ↔ remote vocabulary (LP-362)
 *   attributes.ts  attribute coercion, both directions (LP-270)
 *   accounts.ts    resource ↔ account mapping, pools to a label (LP-271)
 *   periods.ts     period ↔ container mapping (LP-272, LP-313)
 *   capabilities.ts what a provider can hold as data, plus probed cells (LP-274)
 *   ladder.ts      the degradation ladder as a report: the rung each construct
 *                  lands on, and why (LP-275)
 *   labels.ts      label reconciliation: the claimed set, the push merge, and
 *                  what `provision` creates (LP-308)
 *   ledger.ts      which remote owns which document, derived from every link
 *                  store — the one-remote-per-document rule. A push reports a
 *                  document another remote holds (`skipped: owned_elsewhere`);
 *                  an explicit link is refused.
 *   provider.ts    the four-member shape every provider adapter conforms to
 *   transport/     the Connector contract that knows nothing about boards —
 *                  REST, GraphQL and `gh` connectors (LP-293), plus the
 *                  reliability decorators that slow a sync down instead of
 *                  falling over: retry/backoff and the request budget
 *                  (LP-297). Imported directly, never re-exported here: its
 *                  `Connector` and `RemoteRequest` are transport vocabulary
 *                  and would collide with the board-vocabulary ones in
 *                  `provider.ts`.
 *   transport-error.ts the seam that wraps a transport `RemoteError` into a
 *                  `BoardError` (LP-294).
 *   registry.ts    provider name → implementation (LP-260)
 *   connection-catalogue.ts what connecting to each provider asks for —
 *                  fields, credential keys, conditional keys — derived from
 *                  the providers, for every front end that asks
 *   connection.ts  connect, store a credential, change a connection — the
 *                  refusals every caller without a terminal must share
 *   inspect.ts     ask a remote about itself: reachability, discovery,
 *                  vocabulary and prerequisites, as a report
 *   check.ts       remote config as a check pass, composed by `lpm check` (LP-262)
 *   preflight.ts   every unmappable value, collected before a push writes (LP-273)
 *   prerequisites.ts what the remote must already have for a push to land —
 *                  labels, sprints, Project fields — created by the push itself
 *   plan.ts        planPush / planPull — pure functions, no I/O (LP-280, LP-281)
 *   merge.ts       the field-by-field three-way merge (LP-284)
 *   policy.ts      conflict resolution by policy, per remote and per field (LP-286)
 *   resolutions.ts the pending decisions `lpm remote resolve` records (LP-287)
 *   audit.ts       the sync audit log — one JSONL line per applied sync (LP-352)
 *   conflicts.ts   the merge across a document: policy and resolutions applied (LP-287)
 *   render.ts      a plan as a diff, for --dry-run and the web preview (LP-282)
 *   redact.ts      the one place a secret value becomes `***` (LP-296)
 *   fixtures.ts    record real traffic to fixtures, scrubbed, and replay it
 *                  offline (LP-301)
 *   pull.ts        the pull applier — applyChanges + link bookkeeping (LP-281)
 *   execute.ts     push-side applier (LP-490)
 *   guard.ts       the write-confirmation gate — first write, threshold, and the
 *                  every-run delete gate (LP-350, LP-351)
 *   sync.ts        the sync session — one remote, planned then rendered or
 *                  applied, for `lpm remote push|pull|sync` (LP-341)
 *   scaffold.ts    the mapping scaffold — draft a `mapping:` block from board
 *                  config × capability descriptor (LP-369)
 *   fingerprint.ts mapping fingerprint — detect a mapping change before it
 *                  manufactures phantom conflicts (LP-370)
 *   rebase.ts     re-base a board onto a changed mapping as an explicit
 *                  operation (LP-371)
 *
 * ## The check layering, decided
 *
 * Core's `validation/check.ts` may not import this folder, so `checkBoard`
 * knows nothing about remotes — not even a dangling `scope`. All remote checks
 * live in `check.ts` and are composed by the CLI (`lpm check` calls
 * `checkBoard` then `checkRemoteConfiguration`). Keep it that way: a remote check added to core is the same layering
 * mistake this boundary exists to prevent.
 */
export * from './accounts.js';
export * from './adopt.js';
export * from './audit.js';
export * from './attributes.js';
export * from './capabilities.js';
export * from './check.js';
export * from './comments.js';
export * from './config-file.js';
export * from './conflicts.js';
export * from './coverage.js';
export * from './credentials.js';
export * from './execute.js';
export * from './fingerprint.js';
export * from './fixtures.js';
export * from './guard.js';
export * from './hierarchy.js';
export * from './ladder.js';
export * from './labels.js';
export * from './connection-catalogue.js';
export * from './connection.js';
export * from './inspect.js';
export * from './ledger.js';
export * from './lifecycle.js';
export * from './links.js';
export * from './managed-block.js';
export * from './managed-comment.js';
export * from './mapping.js';
export * from './merge.js';
export * from './periods.js';
export * from './plan.js';
export * from './policy.js';
export * from './preflight.js';
export * from './prerequisites.js';
export * from './provider.js';
export * from './provision.js';
export * from './pull.js';
export * from './rebase.js';
export * from './readiness.js';
export * from './reconcile.js';
export * from './redact.js';
export * from './registry.js';
export * from './remotes.js';
export * from './render.js';
export * from './report.js';
export * from './resolutions.js';
export * from './scaffold.js';
export * from './scope.js';
export * from './selection.js';
export * from './shape.js';
export * from './status.js';
export * from './vocabulary.js';
export * from './sync.js';
export * from './transport-error.js';
